/* Adapted from minsug.me/src/components/PetFigure.astro.
 * Original seeded silhouette, OKLab palette, spring motion and Canvas shading.
 * No session/provider/DOM-panel knowledge belongs in this module.
 */
import type { SemanticState } from "../../shared/ui-contract.ts";
import { rgb, type OKLab } from "./color.ts";
import { drawCompanions, type CompanionConfig } from "./companions.ts";
import companionConfig from "./companions.json" with { type: "json" };
import { drawAttention, type AttentionConfig } from "./attention.ts";
import attentionConfig from "./attention.json" with { type: "json" };

interface Pose {
  amp: number;
  speed: number;
  sx: number;
  sy: number;
  sit: number;
  eye: number;
  lookX: number;
  lookY: number;
  breathe: number;
  pulse: number;
  sway: number;
  field: number;
  wave: number;
  rot: number;
  droop: number;
}

interface Figure extends Pose {
  t: number;
  sleep: number;
  phase: number;
  rotPhase: number;
  tilt: number;
  offX: number;
  offY: number;
  c1: OKLab;
  c2: OKLab;
}

interface Spring {
  v: number;
  vel: number;
  target: number;
}

type ColorSprings = [Spring, Spring, Spring];

const TAU = Math.PI * 2;
const CORE = 0.8;
const SHAPE = {
  seed: 163674600,
  count: 9,
  length: 0.27,
  concave: 1,
  tip: 0.4,
  secondary: 0.21,
  jitter: 0.06,
  spin: 0.65,
  eyeScale: 1.1,
};
const IDLE: Pose = {
  amp: 0.03,
  speed: 0.6,
  sx: 1,
  sy: 1,
  sit: 1,
  eye: 1,
  lookX: 0,
  lookY: 0,
  breathe: 1,
  pulse: 0,
  sway: 0,
  field: 0.6,
  wave: 0.08,
  rot: 0.05,
  droop: 0,
};
const SLEEP: Pose = {
  ...IDLE,
  speed: 0.25,
  breathe: 0,
  field: 0.45,
  wave: 0.03,
  rot: 0.02,
  droop: 0.35,
};
// Matches how long the app waits before dimming an idle Peep.
const SLEEP_DELAY = 5;
const POSES: Record<SemanticState, Pose> = {
  idle: IDLE,
  background: {
    ...IDLE,
    amp: 0.035,
    speed: 0.9,
    eye: 0.8,
    lookY: 0.15,
    breathe: 0.5,
    pulse: 0.2,
    field: 0.75,
    wave: 0.3,
    rot: 0.18,
  },
  working: {
    ...IDLE,
    amp: 0.042,
    speed: 1.6,
    sx: 1.02,
    sy: 0.98,
    eye: 0.6,
    lookY: 0.3,
    breathe: 0,
    pulse: 0.55,
    field: 0.95,
    wave: 0.6,
    rot: 0.3,
  },
  asking: {
    ...IDLE,
    amp: 0.035,
    speed: 0.8,
    sx: 0.96,
    sy: 1.07,
    sit: 0.7,
    eye: 1.35,
    lookY: -0.7,
    breathe: 0.7,
    sway: 0.65,
    field: 0.85,
    wave: 0.16,
    rot: 0.08,
  },
  unknown: {
    ...IDLE,
    amp: 0.018,
    speed: 0.25,
    eye: 0.75,
    lookX: -0.4,
    lookY: -0.2,
    breathe: 0.65,
    field: 0.35,
    wave: 0,
    rot: 0.01,
  },
};
const POSE_KEYS = Object.keys(IDLE) as (keyof Pose)[];
const COLOR_CHANNELS = [0, 1, 2] as const;
const lch = (l: number, c: number, h: number): OKLab => [
  l,
  c * Math.cos((h * Math.PI) / 180),
  c * Math.sin((h * Math.PI) / 180),
];
export const PALETTE: Record<SemanticState, readonly [OKLab, OKLab]> = {
  idle: [lch(0.88, 0.07, 60), lch(0.74, 0.14, 25)],
  background: [lch(0.88, 0.07, 215), lch(0.7, 0.12, 255)],
  working: [lch(0.9, 0.11, 90), lch(0.76, 0.16, 55)],
  asking: [lch(0.86, 0.11, 310), lch(0.66, 0.17, 300)],
  unknown: [lch(0.87, 0.025, 295), lch(0.72, 0.045, 285)],
};
const HARMONICS: readonly (readonly [number, number, number, number])[] = [
  [2, 0.55, 1, 0],
  [3, 0.35, -1.3, 1.7],
  [4, 0.25, 1.7, 4.1],
  [5, 0.15, -2.3, 2.2],
];
const wobble = (theta: number, phase: number): number =>
  HARMONICS.reduce(
    (sum, [k, a, w, p]) => sum + a * Math.sin(k * theta + phase * w + p),
    0,
  );

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = mulberry32(SHAPE.seed);
const SPIKES = Array.from({ length: 64 }, () => random() * 2 - 1);
const ROT0 = random() * TAU;

function toScreen(f: Figure, u: number, v: number): [number, number] {
  const x = u * f.sx,
    y = v * f.sy * (v > 0 ? 1 - 0.1 * f.sit : 1);
  const c = Math.cos(f.tilt),
    s = Math.sin(f.tilt);
  return [x * c - y * s + f.offX, x * s + y * c + f.offY];
}

function profile(x: number): number {
  const { tip, concave } = SHAPE;
  const s =
    (Math.sqrt(x * x + tip * tip) - tip) / (Math.sqrt(1 + tip * tip) - tip);
  return Math.max(0, 1 - s) ** concave;
}

function spikeLength(f: Figure, index: number, theta: number): number {
  const base =
    SHAPE.length * f.field * (1 + SHAPE.jitter * SPIKES[index % 64]!);
  return Math.max(
    0,
    base *
      (1 + f.wave * 0.35 * Math.sin(f.t * 6 - index * 0.9)) *
      (1 - f.droop * 0.7 * (0.5 - 0.5 * Math.sin(theta))),
  );
}

function spikeRadius(f: Figure, theta: number): number {
  const n = SHAPE.count,
    step = TAU / n;
  const t =
    theta - f.rotPhase * SHAPE.spin - ROT0 - f.droop * 0.35 * Math.cos(theta);
  const wrap = (i: number): number => ((i % n) + n) % n;
  const i = Math.round(t / step),
    t2 = t - step / 2,
    i2 = Math.round(t2 / step);
  return Math.max(
    profile((t - i * step) / (step / 2)) * spikeLength(f, wrap(i), theta),
    profile((t2 - i2 * step) / (step / 2)) *
      spikeLength(f, wrap(i2) + 32, theta) *
      SHAPE.secondary,
  );
}

function traceBody(f: Figure, r: number): Path2D {
  const body = new Path2D();
  for (let i = 0; i <= 480; i++) {
    const theta = (i / 480) * TAU;
    const radius =
      CORE * (1 + f.amp * wobble(theta, f.phase)) + spikeRadius(f, theta);
    const [x, y] = toScreen(
      f,
      Math.cos(theta) * radius,
      Math.sin(theta) * radius,
    );
    if (i === 0) body.moveTo(x * r, y * r);
    else body.lineTo(x * r, y * r);
  }
  body.closePath();
  return body;
}

function drawEyes(ctx: CanvasRenderingContext2D, f: Figure, r: number): void {
  const k = r * SHAPE.eyeScale * CORE;
  ctx.fillStyle = ctx.strokeStyle = "rgba(25,28,29,.84)";
  ctx.lineCap = "round";
  for (const side of [-1, 1]) {
    const u = (side * 0.3 + f.lookX * 0.1) * SHAPE.eyeScale * CORE;
    const v = (-0.1 + f.lookY * 0.1) * SHAPE.eyeScale * CORE;
    const [x, y] = toScreen(f, u, v);
    ctx.beginPath();
    if (f.sleep > 0.85) {
      const w = 0.085 * k;
      ctx.lineWidth = 0.034 * k;
      ctx.moveTo(x * r - w, y * r - 0.01 * k);
      ctx.quadraticCurveTo(
        x * r,
        y * r + 0.06 * k,
        x * r + w,
        y * r - 0.01 * k,
      );
      ctx.stroke();
      continue;
    }
    const height = Math.max(0.018, 0.13 * f.eye * (1 - f.sleep));
    ctx.ellipse(
      x * r,
      y * r + (0.13 * f.eye - height) * k * 0.5,
      0.085 * k,
      height * k,
      f.tilt,
      0,
      TAU,
    );
    ctx.fill();
  }
}

function drawSnores(ctx: CanvasRenderingContext2D, f: Figure, r: number): void {
  if (f.sleep < 0.01) return;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let i = 0; i < 3; i++) {
    const u = (f.t / 2.6 + i / 3) % 1;
    ctx.save();
    ctx.translate(
      r * (0.5 + u * 0.3) + Math.sin(u * TAU) * r * 0.05,
      -r * (0.6 + u * 0.55),
    );
    ctx.rotate(-0.15);
    ctx.font = `700 ${Math.round(r * (0.22 + u * 0.14))}px -apple-system, system-ui, sans-serif`;
    ctx.fillStyle = rgb(
      [f.c2[0] - 0.12, f.c2[1], f.c2[2]],
      0.85 * f.sleep * Math.sin(Math.PI * u),
    );
    ctx.fillText("z", 0, 0);
    ctx.restore();
  }
}

function draw(
  ctx: CanvasRenderingContext2D,
  f: Figure,
  width: number,
  height: number,
  ratio: number,
): Path2D | null {
  const r = Math.min(width, height) * 0.3;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  if (r <= 0 || ctx.canvas.width === 0 || ctx.canvas.height === 0) return null;
  ctx.translate(width / 2, height * 0.52);
  const body = traceBody(f, r);
  ctx.save();
  ctx.shadowColor = rgb(f.c2, 0.42);
  ctx.shadowBlur = r * 0.45 * ratio;
  ctx.shadowOffsetY = r * 0.08 * ratio;
  ctx.fillStyle = rgb(f.c1);
  ctx.fill(body);
  ctx.restore();
  ctx.save();
  ctx.clip(body);
  const ox = f.offX * r,
    oy = f.offY * r;
  for (let i = 0; i < 3; i++) {
    const a = f.phase * (0.7 + i * 0.25) + (i * TAU) / 3;
    const bx = ox + Math.cos(a) * r * 0.45,
      by = oy + (Math.sin(a) * 0.4 + 0.15) * r;
    const color: OKLab = i === 1 ? [f.c2[0] + 0.06, f.c2[1], f.c2[2]] : f.c2;
    const glow = ctx.createRadialGradient(bx, by, 0, bx, by, r * 0.95);
    glow.addColorStop(0, rgb(color, 0.85));
    glow.addColorStop(1, rgb(color, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(-r * 2, -r * 2, r * 4, r * 4);
  }
  const highlight = ctx.createRadialGradient(
    ox - r * 0.25,
    oy - r * 0.42,
    0,
    ox - r * 0.25,
    oy - r * 0.42,
    r * 0.6,
  );
  highlight.addColorStop(0, "rgba(255,255,255,.55)");
  highlight.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = highlight;
  ctx.fillRect(-r * 2, -r * 2, r * 4, r * 4);
  ctx.restore();
  drawEyes(ctx, f, r);
  drawSnores(ctx, f, r);
  return body;
}

function spring(v: number): Spring {
  return { v, vel: 0, target: v };
}

function colorSprings(color: OKLab): ColorSprings {
  return [spring(color[0]), spring(color[1]), spring(color[2])];
}

function pixelRatio(): number {
  return Math.min(window.devicePixelRatio || 1, 2);
}

export function createPet(
  canvas: HTMLCanvasElement,
  layers?: { back: HTMLCanvasElement; front: HTMLCanvasElement },
): {
  setState(state: SemanticState): void;
  setCompanions(count: number): void;
  hitTest(x: number, y: number): boolean;
  destroy(): void;
} {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D is required to display the pet.");
  const ctx = context;
  const initial = POSES.unknown;
  const params: Record<keyof Pose, Spring> = {
    amp: spring(initial.amp),
    speed: spring(initial.speed),
    sx: spring(initial.sx),
    sy: spring(initial.sy),
    sit: spring(initial.sit),
    eye: spring(initial.eye),
    lookX: spring(initial.lookX),
    lookY: spring(initial.lookY),
    breathe: spring(initial.breathe),
    pulse: spring(initial.pulse),
    sway: spring(initial.sway),
    field: spring(initial.field),
    wave: spring(initial.wave),
    rot: spring(initial.rot),
    droop: spring(initial.droop),
  };
  const c1 = colorSprings(PALETTE.unknown[0]);
  const c2 = colorSprings(PALETTE.unknown[1]);
  const sleep = spring(0);
  const springs = [...Object.values(params), ...c1, ...c2, sleep];
  const squash = spring(0);
  let shown: SemanticState = "unknown";
  let idleSince = 0;
  let asleep = false;
  const figure: Figure = {
    ...initial,
    t: 0,
    sleep: 0,
    phase: 0,
    rotPhase: 0,
    tilt: 0,
    offX: 0,
    offY: 0,
    c1: [...PALETTE.unknown[0]],
    c2: [...PALETTE.unknown[1]],
  };
  let frame: number | null = null;
  let previous = 0;
  let width = 0;
  let height = 0;
  let ratio = 1;
  let body: Path2D | null = null;
  let destroyed = false;
  let companions = 0;
  let askedAt = 0;
  const layerContexts = layers && {
    back: layers.back.getContext("2d")!,
    front: layers.front.getContext("2d")!,
  };

  function render(): void {
    for (const key of POSE_KEYS) figure[key] = params[key].v;
    const blink = Math.max(0, 1 - Math.abs((figure.t % 4.1) - 3.8) / 0.08);
    const stretch =
      1 +
      figure.breathe * 0.022 * Math.sin(figure.t * 1.7) +
      figure.pulse * 0.045 * Math.sin(figure.t * 9) +
      squash.v * 0.12;
    figure.sleep = Math.min(1, Math.max(0, sleep.v));
    const snore = 1 + 0.045 * figure.sleep * Math.sin(figure.t * 1.15);
    figure.sx /= Math.sqrt(stretch * snore);
    figure.sy *= stretch * snore;
    figure.offY = 0.04 * figure.sleep;
    figure.tilt = figure.sway * 0.1 * Math.sin(figure.t * 0.9);
    figure.eye *= 1 - blink * 0.92;
    for (const channel of COLOR_CHANNELS) {
      figure.c1[channel] = c1[channel].v;
      figure.c2[channel] = c2[channel].v;
    }
    body = draw(ctx, figure, width, height, ratio);
    if (layerContexts)
      drawCompanions(
        layerContexts.back,
        layerContexts.front,
        companionConfig as CompanionConfig,
        companions,
        figure.t,
        { width, height, ratio, palette: [figure.c1, figure.c2] },
      );
    if (layerContexts && shown === "asking")
      drawAttention(
        layerContexts.front,
        attentionConfig as AttentionConfig,
        figure.t - askedAt,
        { width, height, ratio, palette: [figure.c1, figure.c2] },
      );
  }

  function resize(): void {
    if (destroyed) return;
    const box = canvas.getBoundingClientRect();
    width = box.width;
    height = box.height;
    ratio = pixelRatio();
    const pixelWidth = Math.round(width * ratio);
    const pixelHeight = Math.round(height * ratio);
    for (const target of [canvas, layers?.back, layers?.front]) {
      if (!target) continue;
      if (target.width !== pixelWidth) target.width = pixelWidth;
      if (target.height !== pixelHeight) target.height = pixelHeight;
    }
    render();
  }

  function tick(now: number): void {
    frame = null;
    if (destroyed) return;
    const dt = Math.min(1 / 30, (now - previous) / 1000);
    previous = now;
    const k = (TAU / 0.6) ** 2,
      c = (4 * Math.PI * 0.85) / 0.6;
    for (let i = 0; i < 4; i++) {
      for (const s of springs) {
        s.vel += ((k * (s.target - s.v) - c * s.vel) * dt) / 4;
        s.v += (s.vel * dt) / 4;
      }
      squash.vel +=
        ((260 * (squash.target - squash.v) - 14 * squash.vel) * dt) / 4;
      squash.v += (squash.vel * dt) / 4;
    }
    figure.t += dt;
    figure.phase += params.speed.v * dt;
    figure.rotPhase += params.rot.v * dt;
    if (shown === "idle" && !asleep && figure.t - idleSince >= SLEEP_DELAY) {
      asleep = true;
      sleep.target = 1;
      for (const key of POSE_KEYS) params[key].target = SLEEP[key];
    }
    if (pixelRatio() !== ratio) resize();
    else render();
    frame = requestAnimationFrame(tick);
  }

  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();
  previous = performance.now();
  frame = requestAnimationFrame(tick);

  return {
    setState(state: SemanticState): void {
      if (destroyed) return;
      if (state === "working" && shown !== "working") {
        squash.vel = -0.75;
        params.field.vel += 1.5;
      }
      if (state === "asking" && shown !== "asking") askedAt = figure.t;
      if (state === "idle" && shown !== "idle") idleSince = figure.t;
      if (state !== "idle") {
        asleep = false;
        sleep.target = 0;
      }
      shown = state;
      const pose = asleep ? SLEEP : POSES[state];
      for (const key of POSE_KEYS) params[key].target = pose[key];
      for (const channel of COLOR_CHANNELS) {
        c1[channel].target = PALETTE[state][0][channel];
        c2[channel].target = PALETTE[state][1][channel];
      }
      render();
    },
    setCompanions(count: number): void {
      companions = count;
    },
    hitTest(x: number, y: number): boolean {
      if (
        destroyed ||
        !body ||
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        x < 0 ||
        y < 0 ||
        x >= width ||
        y >= height
      ) {
        return false;
      }
      // The drawn path is body-local CSS pixels; neither DPR nor shadow is a hit.
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const hit = ctx.isPointInPath(body, x - width / 2, y - height * 0.52);
      ctx.restore();
      return hit;
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      body = null;
      observer.disconnect();
    },
  };
}
