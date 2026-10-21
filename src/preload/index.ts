import { contextBridge, ipcRenderer } from "electron";
import type { PetBridge, Point, Snapshot } from "../shared/ui-contract.ts";

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
  setPetHit: (hit: boolean) => ipcRenderer.send("pagent:pet-hit", hit),
  beginDrag: () => ipcRenderer.send("pagent:drag-start"),
  endDrag: () => ipcRenderer.send("pagent:drag-end"),
  openSessionList: () => ipcRenderer.send("pagent:list-open"),
  closeSessionList: () => ipcRenderer.send("pagent:list-close"),
});
contextBridge.exposeInMainWorld("pagent", bridge);
