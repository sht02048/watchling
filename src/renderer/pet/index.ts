import { createPet } from "./pet-figure.ts";
import type { Snapshot } from "../../shared/ui-contract.ts";

const canvas = document.querySelector("canvas");
if (!canvas) throw new Error("Pet canvas missing");
const pet = createPet(canvas);
let hit = false;
let pointer: { id: number; x: number; y: number; moved: boolean } | undefined;
function render(snapshot: Snapshot): void {
  pet.setState(snapshot.state);
  canvas!.setAttribute(
    "aria-label",
    `pagent ${snapshot.state}. 클릭하여 세션 확인`,
  );
}
const unsubscribeSnapshot = window.pagent.onSnapshot(render);
const unsubscribeCursor = window.pagent.onCursor((point) => {
  const next = pet.hitTest(point.x, point.y);
  if (next !== hit) {
    hit = next;
    window.pagent.setPetHit(hit);
  }
});
void window.pagent.getSnapshot().then(render);
canvas.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || !pet.hitTest(event.offsetX, event.offsetY)) return;
  hit = true;
  window.pagent.setPetHit(true);
  pointer = {
    id: event.pointerId,
    x: event.screenX,
    y: event.screenY,
    moved: false,
  };
  canvas.setPointerCapture(event.pointerId);
  window.pagent.beginDrag({ x: event.screenX, y: event.screenY });
});
canvas.addEventListener("pointermove", (event) => {
  if (!pointer || pointer.id !== event.pointerId) return;
  if (
    !pointer.moved &&
    Math.hypot(event.screenX - pointer.x, event.screenY - pointer.y) >= 5
  ) {
    pointer.moved = true;
  }
});
function finish(event: PointerEvent, cancelled: boolean): void {
  if (!pointer || pointer.id !== event.pointerId) return;
  const click =
    !pointer.moved &&
    !cancelled &&
    Math.hypot(event.screenX - pointer.x, event.screenY - pointer.y) < 5;
  pointer = undefined;
  window.pagent.endDrag();
  if (canvas!.hasPointerCapture(event.pointerId))
    canvas!.releasePointerCapture(event.pointerId);
  if (click) window.pagent.openSessionList();
}
canvas.addEventListener("pointerup", (event) => finish(event, false));
canvas.addEventListener("pointercancel", (event) => finish(event, true));
canvas.addEventListener("lostpointercapture", (event) => finish(event, true));
window.addEventListener(
  "pagehide",
  () => {
    window.pagent.endDrag();
    unsubscribeSnapshot();
    unsubscribeCursor();
    pet.destroy();
  },
  { once: true },
);
