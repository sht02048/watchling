import { contextBridge, ipcRenderer } from "electron";
import {
  isPoint,
  type PetBridge,
  type Point,
  type Snapshot,
} from "../shared/ui-contract.ts";

function subscribe<T>(
  channel: string,
  listener: (value: T) => void,
): () => void {
  const receive = (_event: Electron.IpcRendererEvent, value: T): void =>
    listener(value);
  ipcRenderer.on(channel, receive);
  return () => ipcRenderer.removeListener(channel, receive);
}

const bridge: PetBridge = Object.freeze({
  getSnapshot: (): Promise<Snapshot> =>
    ipcRenderer.invoke("watchling:snapshot"),
  onSnapshot: (listener: (snapshot: Snapshot) => void) =>
    subscribe("watchling:snapshot-changed", listener),
  onCursor: (listener: (point: Point) => void) =>
    subscribe("watchling:cursor", listener),
  setPetHit: (hit: boolean) => {
    if (typeof hit === "boolean") ipcRenderer.send("watchling:pet-hit", hit);
  },
  beginDrag: (cursor: Point) => {
    if (isPoint(cursor))
      ipcRenderer.send("watchling:drag-start", { x: cursor.x, y: cursor.y });
  },
  endDrag: () => ipcRenderer.send("watchling:drag-end"),
  openSessionList: () => ipcRenderer.send("watchling:list-open"),
  closeSessionList: () => ipcRenderer.send("watchling:list-close"),
  copySessionId: (id: string) => {
    if (typeof id === "string")
      ipcRenderer.send("watchling:copy-session-id", id);
  },
  focusSession: (id: string) => {
    if (typeof id === "string") ipcRenderer.send("watchling:focus-session", id);
  },
});
contextBridge.exposeInMainWorld("watchling", bridge);
