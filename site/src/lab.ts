import "./style.css";
import "./lab.css";
import defaults from "./config.json";
import {
  formatConfig,
  modes,
  ranges,
  validateConfig,
  type Config,
  type NumberKnob,
} from "./config.ts";
import { mountSite } from "./desktop.ts";
import { el } from "./windows.ts";

interface Save {
  at: number;
  config: Config;
}

const STORAGE_KEY = "watchling-lab-saves";
const initial = validateConfig(defaults);
if (!initial) throw new Error("site/src/config.json is invalid");
let config: Config = structuredClone(initial);
const site = mountSite(document.querySelector<HTMLElement>("#app")!, config);
const panel = document.querySelector<HTMLElement>(".lab")!;
const setters: (() => void)[] = [];

function set(next: Config): void {
  config = next;
  site.update(structuredClone(config));
  for (const sync of setters) sync();
}

function field(label: string, control: HTMLElement, output?: HTMLElement) {
  const row = el("label", "knob");
  const head = el("span", "knob-head");
  head.append(el("span", "", label));
  if (output) head.append(output);
  row.append(head, control);
  return row;
}

function slider(
  label: string,
  unit: string,
  range: { min: number; max: number; step: number },
  read: () => number,
  write: (value: number) => Config,
): HTMLElement {
  const input = el("input");
  Object.assign(input, {
    type: "range",
    min: String(range.min),
    max: String(range.max),
    step: String(range.step),
  });
  const output = el("output", "");
  const sync = () => {
    input.value = String(read());
    output.textContent = `${read()}${unit}`;
  };
  input.addEventListener("input", () => set(write(Number(input.value))));
  setters.push(sync);
  sync();
  return field(label, input, output);
}

const numberKnob = (key: NumberKnob, label: string, unit: string) =>
  slider(
    label,
    unit,
    ranges[key],
    () => config[key],
    (value) => ({ ...config, [key]: value }),
  );

const durationKnob = (index: 0 | 1) =>
  slider(
    `Agent ${index + 1} finishes after`,
    " s",
    ranges.agentDuration,
    () => config.agentDurations[index],
    (value) => {
      const durations: [number, number] = [...config.agentDurations];
      durations[index] = value;
      return { ...config, agentDurations: durations };
    },
  );

const modeSelect = el("select");
for (const mode of modes) modeSelect.append(new Option(mode, mode));
modeSelect.addEventListener("change", () =>
  set({ ...config, mode: modeSelect.value as Config["mode"] }),
);
setters.push(() => (modeSelect.value = config.mode));
modeSelect.value = config.mode;

const reset = el("button", "lab-button", "Reset demo");
reset.type = "button";
reset.addEventListener("click", () => site.reset());
const save = el("button", "lab-button primary", "Save config");
save.type = "button";
const status = el("p", "lab-status");
status.setAttribute("aria-live", "polite");
const rail = el("ol", "lab-rail");
rail.setAttribute("aria-label", "Recent saves");

function readSaves(): Save[] {
  try {
    const saves: unknown = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? "[]",
    );
    return Array.isArray(saves)
      ? saves.filter(
          (item): item is Save =>
            typeof item?.at === "number" &&
            validateConfig(item.config) !== null,
        )
      : [];
  } catch {
    return [];
  }
}

function renderRail(): void {
  rail.replaceChildren(
    ...readSaves().map((item) => {
      const button = el(
        "button",
        "lab-save",
        `${new Date(item.at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" })} · ${item.config.mode}`,
      );
      button.type = "button";
      button.title = JSON.stringify(item.config);
      button.addEventListener("click", () => {
        set(structuredClone(item.config));
        status.textContent = "Applied a recent save";
      });
      const row = el("li");
      row.append(button);
      return row;
    }),
  );
}

save.addEventListener("click", async () => {
  const json = formatConfig(config);
  try {
    await navigator.clipboard.writeText(json);
  } catch {
    // Clipboard access can be denied; the file write below still matters.
  }
  try {
    const response = await fetch("/__lab/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: json,
    });
    if (!response.ok) throw new Error(String(response.status));
    status.textContent = `Saved to ${await response.text()}`;
    try {
      const saves = [{ at: Date.now(), config }, ...readSaves()].slice(0, 5);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(saves));
    } catch {
      // Storage can be unavailable in private windows.
    }
    renderRail();
  } catch (error) {
    status.textContent = `Save failed (${error instanceof Error ? error.message : "unknown"})`;
  }
});

const collapse = el("button", "lab-collapse", "Hide");
collapse.type = "button";
collapse.setAttribute("aria-expanded", "true");
collapse.addEventListener("click", () => {
  const collapsed = panel.classList.toggle("collapsed");
  collapse.textContent = collapsed ? "Show" : "Hide";
  collapse.setAttribute("aria-expanded", String(!collapsed));
});
const title = el("div", "lab-head");
title.append(el("h2", "lab-title", "Landing lab"), collapse);
const body = el("div", "lab-body");
const actions = el("div", "lab-actions");
actions.append(reset, save);
panel.append(title, body);
body.append(
  field("Mode", modeSelect),
  numberKnob("typeSpeed", "Type speed", " ms/line"),
  durationKnob(0),
  durationKnob(1),
  numberKnob("peepSize", "Peep max size", " px"),
  numberKnob("wallpaperHue", "Wallpaper hue", "°"),
  actions,
  status,
  el("h3", "lab-subtitle", "Recent saves"),
  rail,
);
renderRail();
