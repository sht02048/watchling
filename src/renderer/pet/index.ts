import { createPet } from "./pet-figure.ts";
import { stateLabels, type Snapshot } from "../../shared/ui-contract.ts";

const canvas = document.querySelector<HTMLCanvasElement>("#pet");
const back = document.querySelector<HTMLCanvasElement>("#back");
const front = document.querySelector<HTMLCanvasElement>("#front");
if (!canvas || !back || !front) throw new Error("Pet canvas missing");
const pet = createPet(canvas, { back, front });
let hit = false;
let pointer: { id: number; x: number; y: number; moved: boolean } | undefined;
function render(snapshot: Snapshot): void {
  pet.setState(snapshot.state);
  pet.setCompanions(snapshot.companions);
  canvas!.setAttribute(
    "aria-label",
    `Peep ${stateLabels[snapshot.state]}. Click to see sessions`,
  );
}
const unsubscribeSnapshot = window.watchling.onSnapshot(render);
const unsubscribeCursor = window.watchling.onCursor((point) => {
  const next = pet.hitTest(point.x, point.y);
  if (next !== hit) {
    hit = next;
    window.watchling.setPetHit(hit);
  }
});
void window.watchling.getSnapshot().then(render);
canvas.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || !pet.hitTest(event.offsetX, event.offsetY)) return;
  hit = true;
  window.watchling.setPetHit(true);
  pointer = {
    id: event.pointerId,
    x: event.screenX,
    y: event.screenY,
    moved: false,
  };
  canvas.setPointerCapture(event.pointerId);
  window.watchling.beginDrag({ x: event.screenX, y: event.screenY });
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
  window.watchling.endDrag();
  if (canvas!.hasPointerCapture(event.pointerId))
    canvas!.releasePointerCapture(event.pointerId);
  if (click) window.watchling.openSessionList();
}
canvas.addEventListener("pointerup", (event) => finish(event, false));
canvas.addEventListener("pointercancel", (event) => finish(event, true));
canvas.addEventListener("lostpointercapture", (event) => finish(event, true));
window.addEventListener(
  "pagehide",
  () => {
    window.watchling.endDrag();
    unsubscribeSnapshot();
    unsubscribeCursor();
    pet.destroy();
  },
  { once: true },
);
