import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  Menu,
  nativeImage,
  type MenuItemConstructorOptions,
  protocol,
  screen,
  session,
  shell,
  Tray,
} from "electron";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { contentSecurityPolicy } from "../shared/csp.ts";
import { resolveRendererAsset } from "./renderer-assets.ts";
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
import type { ClaudeConnection } from "./connection.ts";
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

const rendererRoot = join(dirname(__dirname), "renderer");
const viewUrls = {
  pet: new URL(PET_VITE_DEV_SERVER_URL ?? "watchling://app/pet/index.html")
    .href,
  sessions: new URL(
    SESSIONS_VITE_DEV_SERVER_URL ?? "watchling://app/sessions/index.html",
  ).href,
};
const size = { width: 180, height: 180 };
const listSize = { width: 320, height: 280 };
// Transparent margin around the body that may sit past the display edge.
const petInset = 30;
const csp = contentSecurityPolicy("'none'");
let pet: BrowserWindow | undefined;
let list: BrowserWindow | undefined;
let tray: Tray | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let dragTimer: ReturnType<typeof setInterval> | undefined;
let detachIpc: (() => void) | undefined;
let store: PositionStore | undefined;
let connection:
  | Pick<
      ClaudeConnection,
      "available" | "start" | "isConnected" | "setConnected" | "removeHooks"
    >
  | undefined;
let connected = false;
let collector: Awaited<ReturnType<typeof startCollector>> | undefined;
let publisher: ReturnType<typeof createSnapshotPublisher> | undefined;
let quitting = false;
let quitFlushed = false;
let cleanupStarted = false;
let startup: Promise<void> | undefined;
let dragging:
  | { cursor: Point; origin: Point; moved: boolean; last?: Point }
  | undefined;
let hit = false;
let listHiddenAt = 0;
let pressClosedList = false;
let ignoring = true;
const observations = new Observations();
let snapshot = observations.snapshot();
let trayState: SemanticState | undefined;

function updateTray(): void {
  if (!tray || tray.isDestroyed() || trayState === snapshot.state) return;
  trayState = snapshot.state;
  tray.setToolTip(`Watchling — ${stateLabels[trayState]}`);
}

function insidePeep(x: number, y: number): boolean {
  const dx = x - 9;
  const dy = y - 9.4;
  const angle = Math.atan2(dy, dx);
  const radius =
    7.1 *
    (1 + 0.042 * Math.cos(9 * angle + 0.2) + 0.017 * Math.cos(7 * angle + 0.6));
  if (Math.hypot(dx, dy) > radius) return false;
  return [6.4, 11.6].every(
    (eye) => ((x - eye) / 1.15) ** 2 + ((y - 9.4) / 1.6) ** 2 > 1,
  );
}

function trayIcon(): Electron.NativeImage {
  const size = 36;
  const samples = 4;
  const bitmap = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let sy = 0; sy < samples; sy++)
        for (let sx = 0; sx < samples; sx++)
          if (
            insidePeep(
              ((x + (sx + 0.5) / samples) * 18) / size,
              ((y + (sy + 0.5) / samples) * 18) / size,
            )
          )
            hits++;
      bitmap[(y * size + x) * 4 + 3] = Math.round((hits / samples ** 2) * 255);
    }
  }
  const icon = nativeImage.createFromBitmap(bitmap, {
    width: size,
    height: size,
    scaleFactor: 2,
  });
  icon.setTemplateImage(true);
  return icon;
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

function updateMenu(): void {
  if (!tray || tray.isDestroyed()) return;
  const item: MenuItemConstructorOptions = connection?.available
    ? {
        label: "Connected to Claude Code",
        type: "checkbox",
        checked: connected,
        click: (menuItem) => void toggleConnection(menuItem.checked),
      }
    : {
        label: "Move Watchling to Applications to connect Claude Code",
        enabled: false,
      };
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show pet", click: showPet },
      { label: "Hide pet", click: hidePet },
      { type: "separator" },
      item,
      { type: "separator" },
      ...(connection?.available
        ? [{ label: "Uninstall Watchling…", click: () => void uninstall() }]
        : []),
      { label: "Quit", click: () => app.quit() },
    ]),
  );
}

async function uninstall(): Promise<void> {
  app.focus({ steal: true });
  const { response } = await dialog.showMessageBox({
    type: "warning",
    message: "Uninstall Watchling?",
    detail:
      "Watchling removes its Claude Code hooks, moves itself to the Trash and quits. Your other Claude Code settings stay as they are.",
    buttons: ["Uninstall", "Cancel"],
    defaultId: 1,
    cancelId: 1,
  });
  if (response !== 0) return;
  if (!(await connection?.removeHooks())) {
    await dialog.showMessageBox({
      type: "error",
      message: "Watchling could not remove its Claude Code hooks",
      detail:
        "Nothing was moved to the Trash. Untick Connected to Claude Code, then try again.",
    });
    return;
  }
  try {
    await shell.trashItem(dirname(dirname(dirname(process.execPath))));
  } catch {
    await dialog.showMessageBox({
      type: "error",
      message: "Watchling could not move itself to the Trash",
      detail:
        "Its Claude Code hooks are removed. Drag Watchling from Applications to the Trash.",
    });
  }
  app.quit();
}

async function refreshConnection(): Promise<void> {
  connected = (await connection?.isConnected()) ?? false;
  updateMenu();
}

async function toggleConnection(value: boolean): Promise<void> {
  await connection?.setConnected(value);
  await refreshConnection();
}

function hideList(): void {
  if (!list?.isVisible()) return;
  list.hide();
  listHiddenAt = performance.now();
}

function showList(): void {
  if (pressClosedList) {
    pressClosedList = false;
    return;
  }
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
  protocol.handle("watchling", async (request) => {
    const asset = resolveRendererAsset(
      request.method,
      request.url,
      rendererRoot,
    );
    if (!asset) return new Response(null, { status: 404 });
    try {
      const bytes = await readFile(asset.path);
      return new Response(bytes, {
        headers: {
          "Content-Type": `${asset.mime}; charset=utf-8`,
          "Content-Security-Policy": csp,
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return new Response(null, { status: 404 });
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
    preload: join(__dirname, "preload.cjs"),
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
    title: "Watchling",
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
    title: "Watchling sessions",
    backgroundColor: "#faf8f3",
    webPreferences,
  });
  configureWindow(pet);
  configureWindow(list);
  pet.setIgnoreMouseEvents(true, { forward: true });
  list.on("blur", hideList);
  detachIpc = attachIpc({
    pet,
    list,
    urls: viewUrls,
    snapshot: () => snapshot,
    hit: (value) => {
      hit = value;
      updateInput();
    },
    beginDrag: (cursor) => {
      // The list blurs on the same press, so it may already be hidden when this arrives.
      pressClosedList =
        !!list?.isVisible() || performance.now() - listHiddenAt < 300;
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
      hideList();
      updateInput();
    },
    endDrag,
    openList: showList,
    closeList: () => list?.hide(),
    copy: (text) => clipboard.writeText(text),
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
    pet.loadURL(viewUrls.pet),
    list.loadURL(viewUrls.sessions),
  ]);
  tray = new Tray(trayIcon());
  updateTray();
  updateMenu();
  if (connection?.available) void connection.start().then(refreshConnection);
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
              window.webContents.send("watchling:snapshot-changed", value);
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
      onSessionLoss: (sessionId) => {
        observations.loseSession(sessionId);
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
      pet.webContents.send("watchling:cursor", {
        x: cursor.x - bounds.x,
        y: cursor.y - bounds.y,
      });
    } finally {
      finishTrace?.();
    }
  }, 50);
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
  claude?: typeof connection,
): Promise<void> {
  connection = claude;
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
        console.error("Watchling startup failed");
        app.quit();
      });
  }
}
