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
  getSnapshot: (): Promise<Snapshot> => ipcRenderer.invoke("pagent:snapshot"),
  onSnapshot: (listener: (snapshot: Snapshot) => void) =>
    subscribe("pagent:snapshot-changed", listener),
  onCursor: (listener: (point: Point) => void) =>
    subscribe("pagent:cursor", listener),
  setPetHit: (hit: boolean) => {
    if (typeof hit === "boolean") ipcRenderer.send("pagent:pet-hit", hit);
  },
  beginDrag: (cursor: Point) => {
    if (isPoint(cursor))
      ipcRenderer.send("pagent:drag-start", { x: cursor.x, y: cursor.y });
  },
  endDrag: () => ipcRenderer.send("pagent:drag-end"),
  openSessionList: () => ipcRenderer.send("pagent:list-open"),
  closeSessionList: () => ipcRenderer.send("pagent:list-close"),
});
contextBridge.exposeInMainWorld("pagent", bridge);
