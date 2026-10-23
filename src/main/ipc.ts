import { ipcMain } from "electron";
import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { isPoint, type Point, type Snapshot } from "../shared/ui-contract.ts";

type Request = IpcMainEvent | IpcMainInvokeEvent;
export function ownsFrame(
  event: Request,
  window: BrowserWindow,
  url: string,
): boolean {
  return (
    !window.isDestroyed() &&
    event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame &&
    event.senderFrame.url === url
  );
}

export function attachIpc(options: {
  pet: BrowserWindow;
  list: BrowserWindow;
  urls: { pet: string; sessions: string };
  snapshot: () => Snapshot;
  hit: (value: boolean) => void;
  beginDrag: (cursor: Point) => void;
  endDrag: () => void;
  openList: () => void;
  petMenu: () => void;
  closeList: () => void;
  copy: (text: string) => void;
  focus: (id: string) => void;
  menu: (id: string) => void;
}): () => void {
  const listeners: [
    string,
    (event: IpcMainEvent, ...args: unknown[]) => void,
  ][] = [];
  let windowStart = 0;
  let messages = 0;
  const allow = (): boolean => {
    const now = performance.now();
    if (now - windowStart >= 1000) {
      windowStart = now;
      messages = 0;
    }
    return ++messages <= 120;
  };
  ipcMain.handle("watchling:snapshot", (event, ...args: unknown[]) => {
    if (
      args.length !== 0 ||
      !allow() ||
      !(
        ownsFrame(event, options.pet, options.urls.pet) ||
        ownsFrame(event, options.list, options.urls.sessions)
      )
    ) {
      throw new Error("Unauthorized snapshot request");
    }
    return options.snapshot();
  });
  function listen(
    channel: string,
    role: "pet" | "sessions",
    handler: (...args: unknown[]) => void,
  ): void {
    const listener = (event: IpcMainEvent, ...args: unknown[]): void => {
      if (
        !ownsFrame(
          event,
          role === "pet" ? options.pet : options.list,
          options.urls[role],
        ) ||
        !allow()
      )
        return;
      handler(...args);
    };
    ipcMain.on(channel, listener);
    listeners.push([channel, listener]);
  }
  listen("watchling:pet-hit", "pet", (...args) => {
    if (args.length === 1 && typeof args[0] === "boolean") options.hit(args[0]);
  });
  listen("watchling:drag-start", "pet", (...args) => {
    if (args.length === 1 && isPoint(args[0])) options.beginDrag(args[0]);
  });
  for (const [channel, handler] of [
    ["watchling:drag-end", options.endDrag],
    ["watchling:list-open", options.openList],
    ["watchling:pet-menu", options.petMenu],
  ] as const) {
    listen(channel, "pet", (...args) => {
      if (args.length === 0) handler();
    });
  }
  listen("watchling:list-close", "sessions", (...args) => {
    if (args.length === 0) options.closeList();
  });
  listen("watchling:copy-session-id", "sessions", (...args) => {
    const id = args[0];
    if (
      args.length === 1 &&
      typeof id === "string" &&
      options.snapshot().sessions.some((session) => session.id === id)
    )
      options.copy(id);
  });
  listen("watchling:session-menu", "sessions", (...args) => {
    const id = args[0];
    if (
      args.length === 1 &&
      typeof id === "string" &&
      options.snapshot().sessions.some((session) => session.id === id)
    )
      options.menu(id);
  });
  listen("watchling:focus-session", "sessions", (...args) => {
    const id = args[0];
    if (
      args.length === 1 &&
      typeof id === "string" &&
      options
        .snapshot()
        .sessions.some((session) => session.id === id && session.focusable)
    )
      options.focus(id);
  });
  return () => {
    ipcMain.removeHandler("watchling:snapshot");
    for (const [channel, listener] of listeners)
      ipcMain.removeListener(channel, listener);
  };
}
