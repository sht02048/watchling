import { createPet, PALETTE } from "../renderer/pet/pet-figure.ts";
import {
  companionModes,
  drawCompanions,
  MAX_COMPANIONS,
  type CompanionConfig,
} from "../renderer/pet/companions.ts";
import defaults from "../renderer/pet/companions.json" with { type: "json" };

type NumberKey = Exclude<keyof CompanionConfig, "mode" | "seed">;
const knobs: [NumberKey, string, number, number, number][] = [
  ["count", "Count", 1, MAX_COMPANIONS, 1],
  ["size", "Size", 0.12, 0.34, 0.01],
  ["radiusX", "Orbit width", 0.8, 1.55, 0.01],
  ["radiusY", "Orbit height", 0.1, 1, 0.01],
  ["speed", "Speed", 0.1, 2.5, 0.05],
  ["spread", "Spacing", 0.3, 1, 0.05],
  ["bob", "Bounce", 0, 0.2, 0.01],
  ["bobSpeed", "Bounce speed", 0.5, 8, 0.1],
  ["wobble", "Wobble", 0, 1.5, 0.05],
  ["spikes", "Spikes", 0, 8, 1],
  ["spikeLength", "Spike length", 0, 0.6, 0.01],
  ["lightness", "Lightness", -0.1, 0.12, 0.01],
  ["depth", "Depth", 0, 1, 0.05],
  ["eye", "Eye size", 0.5, 1.8, 0.05],
  ["eyeY", "Eye height", -0.3, 0.25, 0.01],
  ["blush", "Blush", 0, 0.6, 0.02],
  ["surface", "Surface distance", 0.7, 1.2, 0.01],
];
const modeLabels = {
  head: "Head",
  sides: "Sides",
  climb: "Slide",
  orbit: "Orbit",
  wander: "Wander",
  hop: "Hop",
};
const backgrounds = { light: "Light", dark: "Dark", checker: "Transparent" };
const sizes = { large: "2×", actual: "Actual size" };
const STORAGE = "pagent.companions.saved";

let config: CompanionConfig = { ...(defaults as CompanionConfig) };
const stage = document.querySelector<HTMLElement>("#stage")!;
const layers = document.querySelector<HTMLElement>("#layers")!;
const [back, front] = ["#back", "#front"].map((id) =>
  document.querySelector<HTMLCanvasElement>(id)!,
) as [HTMLCanvasElement, HTMLCanvasElement];
const pet = createPet(document.querySelector<HTMLCanvasElement>("#pet")!);
pet.setState("background");

const inputs = new Map<NumberKey, [HTMLInputElement, HTMLOutputElement]>();
for (const [key, label, min, max, step] of knobs) {
  const row = document.createElement("label");
  row.className = "knob";
  const output = document.createElement("output");
  const input = Object.assign(document.createElement("input"), {
    type: "range",
    min: String(min),
    max: String(max),
    step: String(step),
  });
  input.addEventListener("input", () => {
    config = { ...config, [key]: Number(input.value) };
    sync();
  });
  row.append(label, output, input);
  document.querySelector("#knobs")!.append(row);
  inputs.set(key, [input, output]);
}

const modeButtons = companionModes.map((mode) => {
  const button = Object.assign(document.createElement("button"), {
    type: "button",
    textContent: modeLabels[mode],
  });
  button.addEventListener("click", () => {
    config = { ...config, mode };
    sync();
  });
  document.querySelector("#modes")!.append(button);
  return button;
});

function radios(
  container: string,
  options: Record<string, string>,
  initial: string,
  apply: (value: string) => void,
): void {
  for (const [value, label] of Object.entries(options)) {
    const option = document.createElement("label");
    const input = Object.assign(document.createElement("input"), {
      type: "radio",
      name: container,
      value,
      checked: value === initial,
    });
    input.addEventListener("change", () => apply(value));
    option.append(input, ` ${label}`);
    document.querySelector(container)!.append(option);
  }
}
radios("#backgrounds", backgrounds, "light", (value) => {
  stage.dataset.background = value;
});
radios("#sizes", sizes, "large", (value) => {
  layers.dataset.size = value;
});

function sync(): void {
  for (const [key, [input, output]] of inputs) {
    input.value = String(config[key]);
    output.textContent = String(config[key]);
  }
  modeButtons.forEach((button, index) =>
    button.setAttribute(
      "aria-pressed",
      String(companionModes[index] === config.mode),
    ),
  );
  document.querySelector("#seed")!.textContent = String(config.seed);
}

stage.addEventListener("click", (event) => {
  if (event.target instanceof HTMLInputElement) return;
  config = { ...config, seed: Math.floor(Math.random() * 2 ** 31) };
  sync();
});

function readSaved(): CompanionConfig[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE) ?? "[]");
  } catch {
    return [];
  }
}
function renderRail(): void {
  const rail = document.querySelector("#rail")!;
  rail.replaceChildren(
    ...readSaved().map((saved) => {
      const item = document.createElement("li");
      const button = Object.assign(document.createElement("button"), {
        type: "button",
        textContent: `${modeLabels[saved.mode]} · ${saved.count}× · seed ${saved.seed}`,
      });
      button.addEventListener("click", () => {
        config = { ...saved };
        sync();
      });
      item.append(button);
      return item;
    }),
  );
}

document.querySelector("#save")!.addEventListener("click", async () => {
  const status = document.querySelector("#saved-to")!;
  const json = JSON.stringify(config, null, 2);
  try {
    localStorage.setItem(
      STORAGE,
      JSON.stringify([config, ...readSaved()].slice(0, 12)),
    );
  } catch {}
  renderRail();
  try {
    const response = await fetch("/api/companions", {
      method: "POST",
      body: json,
    });
    if (!response.ok) throw new Error(String(response.status));
    status.textContent = `Saved to ${await response.text()}`;
  } catch {
    await navigator.clipboard?.writeText(json).catch(() => {});
    status.textContent = "No server: copied to the clipboard";
  }
});

let start = performance.now();
function frame(now: number): void {
  const box = back.getBoundingClientRect();
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  for (const canvas of [back, front]) {
    const width = Math.round(box.width * ratio);
    const height = Math.round(box.height * ratio);
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
  }
  drawCompanions(
    back.getContext("2d")!,
    front.getContext("2d")!,
    config,
    config.count,
    (now - start) / 1000,
    {
      width: box.width,
      height: box.height,
      ratio,
      palette: PALETTE.background,
    },
  );
  requestAnimationFrame(frame);
}

sync();
renderRail();
start = performance.now();
requestAnimationFrame(frame);
