import { createPet, PALETTE } from "../renderer/pet/pet-figure.ts";
import {
  attentionModes,
  drawAttention,
  type AttentionConfig,
} from "../renderer/pet/attention.ts";
import defaults from "../renderer/pet/attention.json" with { type: "json" };

type NumberKey = Exclude<keyof AttentionConfig, "mode" | "seed">;
const knobs: [NumberKey, string, number, number, number][] = [
  ["size", "Size", 0.35, 1.1, 0.01],
  ["offsetX", "Horizontal offset", -0.9, 0.9, 0.01],
  ["height", "Height", 0.7, 1.45, 0.01],
  ["tilt", "Tilt", -0.5, 0.5, 0.01],
  ["popDuration", "Pop duration (s)", 0.2, 1.2, 0.05],
  ["overshoot", "Pop overshoot", 0, 0.9, 0.05],
  ["interval", "Burst interval (s)", 3, 40, 0.5],
  ["jitter", "Interval jitter", 0, 0.5, 0.05],
  ["burstDuration", "Burst duration (s)", 0.3, 1.2, 0.05],
  ["burstStrength", "Burst strength", 0.1, 1.2, 0.05],
  ["outline", "Outline", 0.04, 0.22, 0.01],
  ["fillLightness", "Fill lightness", 0, 1, 0.05],
];
const modeLabels: Record<AttentionConfig["mode"], string> = {
  bang: "!",
  interrobang: "!?",
  question: "?",
  bubble: "Bubble",
  kizuki: "Notice lines",
  ping: "Ping",
};
const backgrounds = { light: "Light", dark: "Dark", checker: "Transparent" };
const sizes = { large: "2×", actual: "Actual size" };
const STORAGE = "pagent.attention.saved";

let config: AttentionConfig = { ...(defaults as AttentionConfig) };
const stage = document.querySelector<HTMLElement>("#stage")!;
const layers = document.querySelector<HTMLElement>("#layers")!;
const front = document.querySelector<HTMLCanvasElement>("#front")!;
const pet = createPet(document.querySelector<HTMLCanvasElement>("#pet")!);
pet.setState("asking");
let askedAt = performance.now();

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

const modeButtons = attentionModes.map((mode) => {
  const button = Object.assign(document.createElement("button"), {
    type: "button",
    textContent: modeLabels[mode],
  });
  button.addEventListener("click", () => {
    config = { ...config, mode };
    replay();
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

function replay(): void {
  askedAt = performance.now();
}
document.querySelector("#replay")!.addEventListener("click", replay);

function sync(): void {
  for (const [key, [input, output]] of inputs) {
    input.value = String(config[key]);
    output.textContent = String(config[key]);
  }
  modeButtons.forEach((button, index) =>
    button.setAttribute(
      "aria-pressed",
      String(attentionModes[index] === config.mode),
    ),
  );
  document.querySelector("#seed")!.textContent = String(config.seed);
}

stage.addEventListener("click", () => {
  config = { ...config, seed: Math.floor(Math.random() * 2 ** 31) };
  replay();
  sync();
});

function readSaved(): AttentionConfig[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE) ?? "[]");
  } catch {
    return [];
  }
}
function renderRail(): void {
  document.querySelector("#rail")!.replaceChildren(
    ...readSaved().map((saved) => {
      const item = document.createElement("li");
      const button = Object.assign(document.createElement("button"), {
        type: "button",
        textContent: `${modeLabels[saved.mode]} · ${saved.interval}s · seed ${saved.seed}`,
      });
      button.addEventListener("click", () => {
        config = { ...saved };
        replay();
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
    const response = await fetch("/api/attention", {
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

function frame(now: number): void {
  const box = front.getBoundingClientRect();
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.round(box.width * ratio);
  const height = Math.round(box.height * ratio);
  if (front.width !== width) front.width = width;
  if (front.height !== height) front.height = height;
  const ctx = front.getContext("2d")!;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, box.width, box.height);
  const t = (now - askedAt) / 1000;
  drawAttention(ctx, config, t, {
    width: box.width,
    height: box.height,
    ratio,
    palette: PALETTE.asking,
  });
  document.querySelector("#elapsed")!.textContent = `${t.toFixed(1)}s`;
  requestAnimationFrame(frame);
}

sync();
renderRail();
requestAnimationFrame(frame);
