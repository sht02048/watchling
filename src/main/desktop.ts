import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  protocol,
  screen,
  session,
  Tray,
} from "electron";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  stateLabels,
  type Point,
  type SemanticState,
  type Snapshot,
} from "../shared/ui-contract.ts";
import { Observations } from "../domain/observations.ts";
import {
  startCollector,
  type CollectorOptions,
} from "../integration/claude/collector.ts";
import { attachIpc } from "./ipc.ts";
import { clampWindow, expand, listPosition } from "./geometry.ts";
import { PositionStore } from "./position-store.ts";
import type { TransportReceipt } from "../integration/claude/protocol.ts";
import {
  createSnapshotPublisher,
  type SnapshotAccounting,
} from "./snapshot-publisher.ts";

export interface DesktopControls {
  collector: Awaited<ReturnType<typeof startCollector>> | undefined;
  hide(): void;
  show(): void;
  getSnapshot(): Snapshot;
  isSnapshotPending(): boolean;
}
// In-process fixture injection only; never exposed through renderer IPC or launch flags.
export interface DesktopOptions {
  scheduleDrain?: CollectorOptions["scheduleDrain"];
  onStarted?: (controls: DesktopControls) => void;
  onTransportReceipt?: (receipt: TransportReceipt) => void;
  onSnapshotAccounting?: (record: SnapshotAccounting) => void;
  trace?: CollectorOptions["trace"];
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const size = { width: 180, height: 180 };
const listSize = { width: 320, height: 280 };
// Transparent margin around the body that may sit past the display edge.
const petInset = 30;
const csp =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
let pet: BrowserWindow | undefined;
let list: BrowserWindow | undefined;
let rendererWatcher: FSWatcher | undefined;
let tray: Tray | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let dragTimer: ReturnType<typeof setInterval> | undefined;
let detachIpc: (() => void) | undefined;
let store: PositionStore | undefined;
let collector: Awaited<ReturnType<typeof startCollector>> | undefined;
let publisher: ReturnType<typeof createSnapshotPublisher> | undefined;
let quitting = false;
let quitFlushed = false;
let cleanupStarted = false;
let startup: Promise<void> | undefined;
let dragging:
  { cursor: Point; origin: Point; moved: boolean; last?: Point } | undefined;
let hit = false;
let ignoring = true;
const observations = new Observations();
let snapshot = observations.snapshot();
let trayState: SemanticState | undefined;

function updateTray(): void {
  if (!tray || tray.isDestroyed() || trayState === snapshot.state) return;
  trayState = snapshot.state;
  tray.setToolTip(`pagent — ${stateLabels[trayState]}`);
}

function queueSnapshot(): void {
  if (!quitting) publisher?.request();
}

function configureWindow(window: BrowserWindow): void {
  window.setAlwaysOnTop(true, "floating");
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      window.hide();
    }
  });
}

function updateInput(): void {
  if (!pet || pet.isDestroyed()) return;
  const next = !dragging && !hit;
  if (next === ignoring) return;
  ignoring = next;
  pet.setIgnoreMouseEvents(next, { forward: true });
}

function updateDrag(cursor: Point): void {
  if (!dragging || !pet || pet.isDestroyed()) return;
  const dx = cursor.x - dragging.cursor.x;
  const dy = cursor.y - dragging.cursor.y;
  if (!dragging.moved && Math.hypot(dx, dy) < 5) return;
  dragging.moved = true;
  const area = expand(screen.getDisplayNearestPoint(cursor).bounds, petInset);
  const position = clampWindow(
    { x: dragging.origin.x + dx, y: dragging.origin.y + dy },
    area,
    size,
  );
  if (dragging.last?.x === position.x && dragging.last.y === position.y) return;
  dragging.last = position;
  pet.setPosition(position.x, position.y);
}

function endDrag(): void {
  if (dragTimer) clearInterval(dragTimer);
  dragTimer = undefined;
  if (dragging) updateDrag(screen.getCursorScreenPoint());
  if (dragging?.moved && pet && !pet.isDestroyed()) {
    const { x, y } = pet.getBounds();
    void store?.save({ x, y });
  }
  dragging = undefined;
  updateInput();
}

function showList(): void {
  if (!pet || !list || dragging) return;
  const petBounds = pet.getBounds();
  const area = screen.getDisplayMatching(petBounds).workArea;
  const position = listPosition(petBounds, area, listSize);
  list.setBounds({ ...position, ...listSize });
  list.show();
  list.focus();
}

function showPet(): void {
  if (!pet) return;
  hit = false;
  updateInput();
  pet.webContents.setBackgroundThrottling(false);
  pet.showInactive();
}

function hidePet(): void {
  endDrag();
  list?.hide();
  pet?.webContents.setBackgroundThrottling(true);
  pet?.hide();
}

function keepOnScreen(): void {
  if (!pet) return;
  endDrag();
  const bounds = pet.getBounds();
  const area = expand(screen.getDisplayMatching(bounds).bounds, petInset);
  const position = clampWindow(bounds, area, size);
  pet.setPosition(position.x, position.y);
  void store?.save(position);
  list?.hide();
}

async function start(options: DesktopOptions): Promise<void> {
  app.dock?.hide();
  session.defaultSession.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.on("will-download", (event) => event.preventDefault());
  const assets = new Map<string, { path: string; mime: string }>();
  for (const view of ["pet", "sessions"]) {
    for (const [file, mime] of [
      ["index.html", "text/html"],
      ["index.js", "text/javascript"],
      ["style.css", "text/css"],
    ] as const) {
      assets.set(`pagent://app/${view}/${file}`, {
        path: join(root, "renderer", view, file),
        mime,
      });
    }
  }
  protocol.handle("pagent", async (request) => {
    const asset = assets.get(request.url);
    if (request.method !== "GET" || !asset)
      return new Response(null, { status: 404 });
    try {
      const bytes = await readFile(asset.path);
      return new Response(bytes, {
        headers: {
          "Content-Type": `${asset.mime}; charset=utf-8`,
          "Content-Security-Policy": csp,
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      console.error("Packaged UI asset could not be read");
      return new Response(null, { status: 500 });
    }
  });
  store = new PositionStore(app.getPath("userData"));
  const saved = await store.load();
  const area = screen.getPrimaryDisplay().workArea;
  const initial = saved ?? {
    x: area.x + area.width - size.width - 24,
    y: area.y + area.height - size.height - 24,
  };
  const display = saved
    ? expand(screen.getDisplayNearestPoint(saved).bounds, petInset)
    : area;
  const position = clampWindow(initial, display, size);
  const webPreferences = {
    preload: join(root, "preload", "index.cjs"),
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    backgroundThrottling: false,
  };
  pet = new BrowserWindow({
    ...size,
    ...position,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    title: "pagent",
    webPreferences,
  });
  list = new BrowserWindow({
    ...listSize,
    show: false,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    title: "pagent sessions",
    backgroundColor: "#faf8f3",
    webPreferences,
  });
  configureWindow(pet);
  configureWindow(list);
  pet.setIgnoreMouseEvents(true, { forward: true });
  list.on("blur", () => list?.hide());
  detachIpc = attachIpc({
    pet,
    list,
    snapshot: () => snapshot,
    hit: (value) => {
      hit = value;
      updateInput();
    },
    beginDrag: (cursor) => {
      if (!pet?.isVisible() || !hit || dragging) return;
      const bounds = pet.getBounds();
      if (
        cursor.x < bounds.x ||
        cursor.x > bounds.x + bounds.width ||
        cursor.y < bounds.y ||
        cursor.y > bounds.y + bounds.height
      )
        return;
      dragging = { cursor, origin: { x: bounds.x, y: bounds.y }, moved: false };
      dragTimer = setInterval(
        () => updateDrag(screen.getCursorScreenPoint()),
        8,
      );
      list?.hide();
      updateInput();
    },
    endDrag,
    openList: showList,
    closeList: () => list?.hide(),
  });
  pet.webContents.on("render-process-gone", () => {
    console.error("Pet renderer exited");
    app.quit();
  });
  list.webContents.on("render-process-gone", () => {
    console.error("Session renderer exited");
    app.quit();
  });
  await Promise.all([
    pet.loadURL("pagent://app/pet/index.html"),
    list.loadURL("pagent://app/sessions/index.html"),
  ]);
  const bitmap = Buffer.alloc(18 * 18 * 4);
  for (let y = 0; y < 18; y++) {
    for (let x = 0; x < 18; x++) {
      const dx = x - 8.5,
        dy = y - 8.5;
      const radius = 6 + Math.cos(Math.atan2(dy, dx) * 9);
      if (Math.hypot(dx, dy) <= radius) bitmap[(y * 18 + x) * 4 + 3] = 255;
    }
  }
  const icon = nativeImage.createFromBitmap(bitmap, { width: 18, height: 18 });
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  updateTray();
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show pet", click: showPet },
      { label: "Hide pet", click: hidePet },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]),
  );
  publisher = createSnapshotPublisher({
    getSnapshot: () => {
      const finishTrace = options.trace?.("snapshot.materialize");
      try {
        snapshot = observations.snapshot();
        updateTray();
        return snapshot;
      } finally {
        finishTrace?.();
      }
    },
    getTargets: () =>
      [pet, list]
        .filter((window): window is BrowserWindow =>
          Boolean(
            window &&
            !window.isDestroyed() &&
            !window.webContents.isDestroyed(),
          ),
        )
        .map((window) => ({
          id: window.id,
          send: (value: Snapshot) => {
            const finishTrace = options.trace?.("snapshot.send");
            try {
              window.webContents.send("pagent:snapshot-changed", value);
            } finally {
              finishTrace?.();
            }
          },
        })),
    ...(options.onSnapshotAccounting
      ? { onAccounting: options.onSnapshotAccounting }
      : {}),
  });
  try {
    collector = await startCollector({
      directory: app.getPath("userData"),
      ...(options.trace ? { trace: options.trace } : {}),
      ...(options.onTransportReceipt
        ? { onReceipt: options.onTransportReceipt }
        : {}),
      ...(options.scheduleDrain
        ? { scheduleDrain: options.scheduleDrain }
        : {}),
      onEvent: (event) => {
        observations.receive(event);
        queueSnapshot();
      },
      onLoss: () => {
        observations.loseIntegrity();
        queueSnapshot();
      },
    });
  } catch {
    observations.receiverFailed();
    queueSnapshot();
    console.error("Private Claude event receiver could not start");
  }
  screen.on("display-removed", keepOnScreen);
  screen.on("display-metrics-changed", keepOnScreen);
  timer = setInterval(() => {
    const finishTrace = options.trace?.("desktop.cursor-tick");
    try {
      if (!pet?.isVisible() || pet.webContents.isDestroyed()) return;
      const cursor = screen.getCursorScreenPoint();
      updateDrag(cursor);
      const bounds = pet.getBounds();
      pet.webContents.send("pagent:cursor", {
        x: cursor.x - bounds.x,
        y: cursor.y - bounds.y,
      });
    } finally {
      finishTrace?.();
    }
  }, 50);
  if (process.env.PAGENT_DEV === "1" && !app.isPackaged) {
    let pending: ReturnType<typeof setTimeout> | undefined;
    rendererWatcher = watch(join(root, "renderer"), { recursive: true }, () => {
      clearTimeout(pending);
      pending = setTimeout(() => {
        console.log("[dev] renderer reloaded");
        for (const window of [pet, list])
          if (window && !window.isDestroyed())
            window.webContents.reloadIgnoringCache();
      }, 150);
    });
  }
  if (!quitting) showPet();
  options.onStarted?.({
    collector,
    hide: hidePet,
    show: showPet,
    getSnapshot: () => snapshot,
    isSnapshotPending: () => publisher?.isPending() ?? false,
  });
}

export async function runDesktop(
  userData: string,
  options: DesktopOptions = {},
): Promise<void> {
  await mkdir(userData, { recursive: true, mode: 0o700 });
  app.setPath("userData", userData);
  app.on("window-all-closed", () => {
    if (quitting) app.quit();
  });
  app.on("before-quit", (event) => {
    quitting = true;
    if (!quitFlushed) {
      event.preventDefault();
      if (cleanupStarted) return;
      cleanupStarted = true;
      void (async () => {
        await startup;
        endDrag();
        if (timer) clearInterval(timer);
        rendererWatcher?.close();
        publisher?.cancel();
        detachIpc?.();
        if (app.isReady()) {
          screen.removeListener("display-removed", keepOnScreen);
          screen.removeListener("display-metrics-changed", keepOnScreen);
        }
        tray?.destroy();
        const results = await Promise.allSettled([
          store?.flush(),
          collector?.close(),
        ]);
        if (results.some((result) => result.status === "rejected"))
          console.error("App resource cleanup failed");
        quitFlushed = true;
        app.quit();
      })();
    }
  });
  if (!app.requestSingleInstanceLock()) app.quit();
  else {
    app.on("second-instance", () => showPet());
    startup = app
      .whenReady()
      .then(() => start(options))
      .catch(() => {
        console.error("pagent startup failed");
        app.quit();
      });
  }
}
