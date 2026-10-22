import { createPet } from "../renderer/pet/pet-figure.ts";
import {
  semanticStates,
  stateLabels,
  type SemanticState,
} from "../shared/ui-contract.ts";

const descriptions: Record<SemanticState, string> = {
  idle: "새 세션이 열렸거나 턴이 끝나 다음 요청을 기다리는 상태예요.",
  background:
    "메인 턴은 끝났지만 백그라운드 서브에이전트가 아직 작업 중이에요.",
  working: "요청을 받아 작업 중이에요. 다른 상태에서 바뀔 때 한 번 튀어요.",
  unknown: "놓친 신호가 있어 상태를 판단할 수 없어요.",
  asking: "승인이나 질문 프롬프트가 떴을 가능성이 높아요.",
};
const backgrounds = { light: "밝게", dark: "어둡게", checker: "투명" };

const stage = document.querySelector<HTMLElement>(".stage")!;
const nav = document.querySelector<HTMLElement>("#states")!;
const description = document.querySelector<HTMLElement>("#description")!;
const backgroundSet = document.querySelector<HTMLElement>("#backgrounds")!;
const cycle = document.querySelector<HTMLInputElement>("#cycle")!;
const pets = ["#actual", "#large"].map((selector) => {
  const canvas = document.querySelector<HTMLCanvasElement>(selector)!;
  const layers = canvas.parentElement!;
  return createPet(canvas, {
    back: layers.querySelector<HTMLCanvasElement>(".back")!,
    front: layers.querySelector<HTMLCanvasElement>(".front")!,
  });
});
const order = [...semanticStates].reverse();
let current: SemanticState = "unknown";
let timer: ReturnType<typeof setInterval> | undefined;

const buttons = order.map((state, index) => {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.state = state;
  button.append(
    Object.assign(document.createElement("kbd"), {
      textContent: String(index + 1),
    }),
    ` ${stateLabels[state]} `,
    Object.assign(document.createElement("code"), { textContent: state }),
  );
  button.addEventListener("click", () => show(state));
  nav.append(button);
  return button;
});

function show(state: SemanticState): void {
  current = state;
  for (const pet of pets) pet.setState(state);
  for (const button of buttons)
    button.setAttribute("aria-pressed", String(button.dataset.state === state));
  description.textContent = descriptions[state];
}

function step(offset: number): void {
  const index = order.indexOf(current);
  show(order[(index + offset + order.length) % order.length]!);
}

for (const [value, label] of Object.entries(backgrounds)) {
  const option = document.createElement("label");
  const input = Object.assign(document.createElement("input"), {
    type: "radio",
    name: "background",
    value,
    checked: value === stage.dataset.background,
  });
  input.addEventListener("change", () => (stage.dataset.background = value));
  option.append(input, ` ${label}`);
  backgroundSet.append(option);
}

for (const count of [0, 1, 2, 3]) {
  const option = document.createElement("label");
  const input = Object.assign(document.createElement("input"), {
    type: "radio",
    name: "companions",
    value: String(count),
    checked: count === 2,
  });
  input.addEventListener("change", () => {
    for (const pet of pets) pet.setCompanions(count);
  });
  option.append(input, ` ${count}`);
  document.querySelector("#companions")!.append(option);
}
for (const pet of pets) pet.setCompanions(2);

cycle.addEventListener("change", () => {
  if (timer) clearInterval(timer);
  timer = cycle.checked ? setInterval(() => step(1), 3000) : undefined;
});

document.addEventListener("keydown", (event) => {
  if (event.target instanceof HTMLInputElement) return;
  const number = Number(event.key);
  if (number >= 1 && number <= order.length) show(order[number - 1]!);
  else if (event.key === "ArrowRight") step(1);
  else if (event.key === "ArrowLeft") step(-1);
});

show(current);
