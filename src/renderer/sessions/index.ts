import { stateLabels, type Snapshot } from "../../shared/ui-contract.ts";

const status = document.querySelector("#observation");
const entries = document.querySelector("#sessions");
if (!status || !entries) throw new Error("Session view missing");
function render(snapshot: Snapshot): void {
  status!.textContent = snapshot.observation;
  entries!.replaceChildren();
  for (const session of snapshot.sessions) {
    const row = document.createElement("li");
    const heading = document.createElement("div");
    const label = document.createElement("strong");
    label.textContent = `${session.project} · ${session.id}`;
    const state = document.createElement("span");
    state.className = `state state-${session.state}`;
    state.textContent = stateLabels[session.state];
    heading.append(label, state);
    const reason = document.createElement("p");
    reason.textContent = session.reason;
    row.append(heading, reason);
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
