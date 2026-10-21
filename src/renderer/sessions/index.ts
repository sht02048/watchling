import type { Snapshot } from "../../shared/ui-contract.ts";

const status = document.querySelector("#observation");
const entries = document.querySelector("#sessions");
if (!status || !entries) throw new Error("Session view missing");
function render(snapshot: Snapshot): void {
  status!.textContent = snapshot.observation;
  entries!.replaceChildren();
  for (const session of snapshot.sessions.filter(
    (item) => item.state === "asking" || item.state === "unknown",
  )) {
    const row = document.createElement("li");
    const label = document.createElement("strong");
    label.textContent = `${session.project} · ${session.id}`;
    const reason = document.createElement("p");
    reason.textContent = session.reason;
    row.append(label, reason);
    entries!.append(row);
  }
}
const unsubscribe = window.pagent.onSnapshot(render);
void window.pagent.getSnapshot().then(render);
document
  .querySelector("#close")
  ?.addEventListener("click", () => window.pagent.closeSessionList());
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") window.pagent.closeSessionList();
});
window.addEventListener("pagehide", unsubscribe, { once: true });
