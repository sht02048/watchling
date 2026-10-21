import { app, BrowserWindow, powerMonitor, protocol, screen } from "electron";
import { Buffer } from "node:buffer";
import { resolveAppPaths } from "../../src/main/app-paths.ts";
import { runDesktop, type DesktopControls } from "../../src/main/desktop.ts";
import type { Snapshot } from "../../src/shared/ui-contract.ts";

type Profile = "N" | "O";
type Stats = Record<string, number | null>;
type Timer = ReturnType<typeof setTimeout>;
type Action = {
  kind: "drag" | "hide" | "show";
  index: number;
  scheduledMs: number;
  dispatchedMs: number;
  latencyMs: number | null;
  passed: boolean;
  error?: string;
  before?: Electron.Rectangle;
  after?: Electron.Rectangle;
};

const home = process.env.HOME;
if (!home || home !== process.env.PAGENT_PROFILE_HOME)
  throw new Error("The profile fixture requires an explicitly disposable HOME");
app.setName("pagent-transport-profile");
protocol.registerSchemesAsPrivileged([
  {
    scheme: "pagent",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

// This entrypoint is bundled separately. No fixture API is registered with IPC.
const timers = new Set<Timer>();
const drains = new Set<() => void>();
const violations = new Set<string>();
const loop: { atMs: number; delayMs: number }[] = [];
const rss: { atMs: number; scheduledMs: number | null; bytes: number }[] = [];
const resources: {
  atMs: number;
  stats: Stats;
  snapshotBytes: number;
  sessions: number;
  pending: boolean;
}[] = [];
const snapshots: { atMs: number; snapshot: Snapshot }[] = [];
const actions: Action[] = [];
const hidden: { fromMs: number; untilMs: number | null }[] = [];
const displaySamples: {
  atMs: number;
  reason: string;
  idleState: string;
  nativeVisible: boolean;
  displayCount: number;
}[] = [];
let controls: DesktopControls | undefined;
let origin = process.hrtime.bigint();
let originPerformanceMs = performance.now();
let loadStart: bigint | undefined;
let durationMs = 0;
let selected: Profile | undefined;
let stopped = false;
let sampling = false;
let lastResources = "";
let lastSnapshot = "";
let firstAuthenticatedDropMs: number | null = null;
let firstUnknownAfterDropMs: number | null = null;
let firstAuthenticatedDropPerformanceMs: number | null = null;
let firstUnknownAfterDropDelayMs: number | null = null;
let unknownBeforeDrop = false;
let heldDrains = 0;
let drainCalls = 0;
let startupError: string | undefined;
let stdoutBytes = 0;
let stderrBytes = 0;

for (const [stream, record] of [
  [process.stdout, (bytes: number) => (stdoutBytes += bytes)],
  [process.stderr, (bytes: number) => (stderrBytes += bytes)],
] as const) {
  const write = stream.write.bind(stream);
  stream.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    record(
      typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength,
    );
    return Reflect.apply(write, stream, [chunk, ...args]);
  }) as typeof stream.write;
}

function at(now = process.hrtime.bigint()): number {
  return Number(now - origin) / 1e6;
}
function later(callback: () => void, milliseconds: number): Timer {
  if (timers.size >= 128) throw new Error("Fixture timer bound exceeded");
  const timer = setTimeout(
    () => {
      timers.delete(timer);
      callback();
    },
    Math.max(0, milliseconds),
  );
  timers.add(timer);
  return timer;
}
function clear(timer: Timer | undefined): void {
  if (!timer) return;
  clearTimeout(timer);
  timers.delete(timer);
}
function append<T>(array: T[], value: T, limit: number, name: string): void {
  if (array.length >= limit) {
    violations.add(`${name} measurement buffer exhausted`);
    return;
  }
  array.push(value);
}
function petWindow(): BrowserWindow {
  const pet = BrowserWindow.getAllWindows().find((window) =>
    window.webContents.getURL().includes("/pet/"),
  );
  if (!pet || pet.isDestroyed()) throw new Error("Pet window is unavailable");
  return pet;
}
function requiredControls(): DesktopControls {
  if (!controls) throw new Error("runDesktop did not provide DesktopControls");
  return controls;
}
function checkStats(): void {
  const current = requiredControls();
  if (!current.collector) {
    violations.add("Production collector did not start");
    return;
  }
  const stats = { ...current.collector.stats() } as unknown as Stats;
  const bounds: Record<string, number> = {
    activeConnections: 16,
    queued: 128,
    maximumQueue: 128,
    queuedBytes: 1024 * 1024,
    maximumQueuedBytes: 1024 * 1024,
    connectionBytes: 128 * 1024,
    maximumConnectionBytes: 128 * 1024,
  };
  for (const key of [
    ...Object.keys(bounds),
    "accepted",
    "rejected",
    "overflow",
    "consumerFailures",
    "authenticatedOverflow",
  ]) {
    const value = stats[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
      violations.add(`Missing or invalid collector statistic: ${key}`);
    else if (key in bounds && value > bounds[key]!)
      violations.add(`Collector ${key} exceeded ${bounds[key]}`);
  }
  const snapshot = current.getSnapshot();
  const encoded = JSON.stringify(snapshot);
  const snapshotBytes = Buffer.byteLength(encoded);
  const pending = current.isSnapshotPending();
  if (snapshotBytes > 128 * 1024) violations.add("Snapshot exceeded 128 KiB");
  if (snapshot.sessions.length > 128)
    violations.add("Snapshot session count exceeded 128");
  if (typeof pending !== "boolean")
    violations.add("isSnapshotPending did not return a boolean");
  const firstDrop = stats.firstAuthenticatedOverflowAt;
  if (
    firstDrop !== null &&
    (typeof firstDrop !== "number" || !Number.isFinite(firstDrop))
  )
    violations.add("Missing or invalid collector firstAuthenticatedOverflowAt");
  if (firstAuthenticatedDropMs === null && stats.authenticatedOverflow! > 0) {
    if (typeof firstDrop === "number" && Number.isFinite(firstDrop)) {
      firstAuthenticatedDropMs = firstDrop - originPerformanceMs;
      firstAuthenticatedDropPerformanceMs = firstDrop;
    } else
      violations.add(
        "Authenticated overflow lacks its exact main-clock timestamp",
      );
  }
  if (firstAuthenticatedDropMs === null && snapshot.state === "unknown")
    unknownBeforeDrop = true;
  if (
    firstAuthenticatedDropMs !== null &&
    firstUnknownAfterDropMs === null &&
    snapshot.state === "unknown"
  ) {
    firstUnknownAfterDropMs = at();
    firstUnknownAfterDropDelayMs =
      performance.now() - firstAuthenticatedDropPerformanceMs!;
  }
  const fingerprint = JSON.stringify([stats, snapshotBytes, pending]);
  if (fingerprint !== lastResources) {
    append(
      resources,
      {
        atMs: at(),
        stats,
        snapshotBytes,
        sessions: snapshot.sessions.length,
        pending,
      },
      16_000,
      "Resource",
    );
    lastResources = fingerprint;
  }
  if (encoded !== lastSnapshot) {
    append(snapshots, { atMs: at(), snapshot }, 512, "Snapshot transition");
    lastSnapshot = encoded;
  }
}
function safeCheck(): void {
  try {
    checkStats();
  } catch (error) {
    violations.add(`Resource sampling failed: ${String(error)}`);
  }
}
function sampleDisplay(reason: string): void {
  try {
    append(
      displaySamples,
      {
        atMs: at(),
        reason,
        idleState: powerMonitor.getSystemIdleState(1),
        nativeVisible: petWindow().isVisible(),
        displayCount: screen.getAllDisplays().length,
      },
      512,
      "Display availability",
    );
  } catch (error) {
    violations.add(
      `Display availability could not be measured: ${String(error)}`,
    );
  }
}
const locked = (): void => sampleDisplay("lock-screen");
const unlocked = (): void => sampleDisplay("unlock-screen");
function beginSampling(): void {
  if (sampling) throw new Error("Warm-up was already started");
  sampling = true;
  origin = process.hrtime.bigint();
  originPerformanceMs = performance.now();
  let tick = 1;
  const probe = (): void => {
    if (stopped) return;
    const now = at();
    // Account for EVERY scheduled 20 ms tick, including ticks lost to a stall.
    while (tick * 20 <= now) {
      append(
        loop,
        { atMs: tick * 20, delayMs: now - tick * 20 },
        12_000,
        "Main loop",
      );
      tick++;
    }
    safeCheck();
    later(probe, tick * 20 - at());
  };
  let memoryTick = 0;
  const memory = (): void => {
    if (stopped) return;
    if (at() < memoryTick * 100) {
      later(memory, memoryTick * 100 - at());
      return;
    }
    append(
      rss,
      {
        atMs: at(),
        scheduledMs: memoryTick * 100,
        bytes: process.memoryUsage().rss,
      },
      2500,
      "RSS",
    );
    if (memoryTick % 10 === 0) sampleDisplay("1s probe");
    memoryTick++;
    const now = at();
    if (now >= memoryTick * 100) {
      violations.add("Main RSS sampling missed a scheduled 100 ms sample");
      memoryTick = Math.floor(now / 100) + 1;
    }
    later(memory, memoryTick * 100 - at());
  };
  probe();
  memory();
}
function scheduleDrain(callback: () => void): () => void {
  let immediate: ReturnType<typeof setImmediate> | undefined;
  let timer: Timer | undefined;
  let cancelled = false;
  const cancel = (): void => {
    cancelled = true;
    if (immediate) clearImmediate(immediate);
    clear(timer);
    drains.delete(cancel);
  };
  const run = (): void => {
    immediate = undefined;
    timer = undefined;
    if (cancelled || stopped) return;
    const elapsed =
      loadStart === undefined
        ? -1
        : Number(process.hrtime.bigint() - loadStart) / 1e6;
    if (selected === "O" && elapsed >= 2000 && elapsed < 4000) {
      heldDrains++;
      timer = later(run, 4000 - elapsed);
      return;
    }
    drains.delete(cancel);
    drainCalls++;
    callback();
  };
  drains.add(cancel);
  if (drains.size > 2)
    violations.add("Unexpected simultaneous consumer drains");
  immediate = setImmediate(run);
  return cancel;
}
async function changed(
  condition: () => boolean,
  deadline: bigint,
): Promise<boolean> {
  while (!stopped) {
    if (condition()) return true;
    if (process.hrtime.bigint() >= deadline) return false;
    await new Promise<void>((resolve) => later(resolve, 5));
  }
  return false;
}
async function drag(index: number, scheduledMs: number): Promise<void> {
  const result: Action = {
    kind: "drag",
    index,
    scheduledMs,
    dispatchedMs: at(),
    latencyMs: null,
    passed: false,
  };
  try {
    const pet = petWindow();
    if (!pet.isVisible()) throw new Error("Pet was hidden at drag dispatch");
    // Setup only: put the window away from a clamped edge. The MEASURED move
    // below is exclusively PetBridge -> production drag handler -> native bounds.
    const bounds = pet.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    pet.setPosition(
      Math.round(area.x + (area.width - bounds.width) / 2),
      Math.round(area.y + (area.height - bounds.height) / 2),
    );
    result.before = pet.getBounds();
    const cursor = screen.getCursorScreenPoint();
    const start = {
      x: result.before.x + result.before.width / 2,
      y: result.before.y + result.before.height / 2,
    };
    if (Math.hypot(cursor.x - start.x, cursor.y - start.y) < 10) start.x += 20;
    result.dispatchedMs = at();
    const dispatched = process.hrtime.bigint();
    const budget = selected === "N" ? 250 : 500;
    // No mouse/keyboard injection and no new IPC. The renderer's real bridge
    // delivers these calls through the existing authenticated pet frame.
    const delivered = pet.webContents.executeJavaScript(`
      window.pagent.setPetHit(true);
      window.pagent.beginDrag(${JSON.stringify(start)});
    `);
    delivered.catch((error: unknown) => {
      violations.add(`Drag bridge delivery failed: ${String(error)}`);
    });
    const moved = await changed(
      () => {
        const next = pet.getBounds();
        return next.x !== result.before!.x || next.y !== result.before!.y;
      },
      dispatched + BigInt(budget) * 1_000_000n,
    );
    result.latencyMs = Number(process.hrtime.bigint() - dispatched) / 1e6;
    result.after = pet.getBounds();
    result.passed = moved && result.latencyMs <= budget;
    if (!moved) result.error = "No native bounds change before drag deadline";
    void pet.webContents
      .executeJavaScript("window.pagent.endDrag()")
      .catch((error: unknown) => {
        violations.add(`Drag end delivery failed: ${String(error)}`);
      });
  } catch (error) {
    result.error = String(error);
  }
  append(actions, result, 30, "Action");
}
function visibility(
  kind: "hide" | "show",
  index: number,
  scheduledMs: number,
): void {
  const dispatched = process.hrtime.bigint();
  const result: Action = {
    kind,
    index,
    scheduledMs,
    dispatchedMs: at(dispatched),
    latencyMs: null,
    passed: false,
  };
  try {
    // These ARE the callbacks installed on the production tray menu.
    const current = requiredControls();
    if (kind === "hide") current.hide();
    else current.show();
    const visible = petWindow().isVisible();
    result.latencyMs = Number(process.hrtime.bigint() - dispatched) / 1e6;
    result.passed =
      visible === (kind === "show") &&
      result.latencyMs <= (selected === "N" ? 250 : 500);
    if (!result.passed)
      result.error = "Native visibility did not meet the action contract";
    if (kind === "hide" && !visible)
      append(hidden, { fromMs: at(), untilMs: null }, 10, "Hidden interval");
    if (kind === "show" && visible) {
      const interval = hidden.at(-1);
      if (interval && interval.untilMs === null) interval.untilMs = at();
    }
  } catch (error) {
    result.error = String(error);
  }
  append(actions, result, 30, "Action");
}
function cleanup(): void {
  stopped = true;
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
  for (const cancel of drains) cancel();
  drains.clear();
  powerMonitor.removeListener("lock-screen", locked);
  powerMonitor.removeListener("unlock-screen", unlocked);
}
app.once("before-quit", cleanup);

const api = {
  get ready(): boolean {
    return controls !== undefined;
  },
  get startupError(): string | undefined {
    return startupError;
  },
  get controls(): DesktopControls | undefined {
    return controls;
  },
  warmup() {
    requiredControls();
    beginSampling();
    return {
      originNs: origin.toString(),
      warmupEndNs: (origin + 10_000_000_000n).toString(),
    };
  },
  arm(profile: Profile, startNs: string) {
    if (!sampling || selected) throw new Error("Invalid profile lifecycle");
    selected = profile;
    durationMs = profile === "N" ? 60_000 : 10_000;
    loadStart = BigInt(startNs);
    if (loadStart <= process.hrtime.bigint())
      throw new Error("Profile start is already past");
    const loadStartMs = at(loadStart);
    const period = durationMs / 10;
    for (let index = 0; index < 10; index++) {
      const dragAt = loadStartMs + index * period + period * 0.1;
      const hideAt = loadStartMs + index * period + period * 0.7;
      const showAt = hideAt + 100;
      later(() => {
        void drag(index, dragAt);
      }, dragAt - at());
      later(() => visibility("hide", index, hideAt), hideAt - at());
      later(() => visibility("show", index, showAt), showAt - at());
    }
    return {
      loadStartMs,
      loadEndMs: loadStartMs + durationMs,
      recoveryEndMs: loadStartMs + durationMs + 30_000,
      versions: process.versions,
      pid: process.pid,
      userData: app.getPath("userData"),
      descriptorPath: requiredControls().collector?.descriptorPath ?? null,
      measurementResolutionMs: {
        loop: 20,
        resources: 20,
        rss: 100,
        actions: 5,
      },
    };
  },
  finish() {
    if (!selected || loadStart === undefined)
      throw new Error("Profile was not armed");
    safeCheck();
    sampleDisplay("finish");
    append(
      rss,
      { atMs: at(), scheduledMs: null, bytes: process.memoryUsage().rss },
      2500,
      "RSS",
    );
    const finishedMs = at();
    const finalStats = requiredControls().collector?.stats() ?? null;
    const finalSnapshot = requiredControls().getSnapshot();
    cleanup();
    return {
      profile: selected,
      durationMs,
      finishedMs,
      loadStartMs: at(loadStart),
      loop,
      rss,
      resources,
      snapshots,
      actions,
      hidden,
      displaySamples,
      finalStats,
      finalSnapshot,
      confidence: {
        firstAuthenticatedDropMs,
        firstAuthenticatedDropPerformanceMs,
        firstUnknownAfterDropMs,
        firstUnknownAfterDropDelayMs,
        unknownBeforeDrop,
        dropClock:
          "Collector performance.now() recorded at the actual authenticated queue drop; unknown latency uses the same main performance clock.",
        note: "Unknown before a drop is not evidence of a confirmed-wait loss transition.",
      },
      drain: {
        heldDrains,
        drainCalls,
        pauseMs: selected === "O" ? [2000, 4000] : null,
      },
      logStreams: { stdoutBytes, stderrBytes, contentsRetained: false },
      collectorBoundEvidence:
        "The production collector asserts count/charged-byte bounds after every state change; this fixture also samples its high-water statistics.",
      violations: [...violations],
      unsupportedEvidence: [
        "DesktopControls exposes one pending boolean, not per-window pending counts/bytes.",
        "Snapshot does not expose active operation/wait or dedup/terminal counts.",
        "Confirmed approval/question wait preservation needs provider/reducer capabilities; unknown-only output cannot prove it.",
      ],
    };
  },
  abort: cleanup,
};
Object.defineProperty(globalThis, "__pagentTransportProfile", { value: api });

await runDesktop(resolveAppPaths(home).userData, {
  scheduleDrain,
  onStarted: (current: DesktopControls) => {
    controls = current;
    powerMonitor.on("lock-screen", locked);
    powerMonitor.on("unlock-screen", unlocked);
    if (!current.collector)
      violations.add("Production collector did not start");
  },
}).catch((error: unknown) => {
  startupError = String(error);
  cleanup();
  app.quit();
});

export type ProfileFixture = typeof api;
export type MainReport = ReturnType<ProfileFixture["finish"]>;
export type ArmReport = ReturnType<ProfileFixture["arm"]>;
