import { rgb, type OKLab } from "./color.ts";

export const companionModes = [
  "head",
  "sides",
  "climb",
  "orbit",
  "wander",
  "hop",
] as const;
export type CompanionMode = (typeof companionModes)[number];

export interface CompanionConfig {
  seed: number;
  mode: CompanionMode;
  count: number;
  size: number;
  radiusX: number;
  radiusY: number;
  speed: number;
  spread: number;
  bob: number;
  bobSpeed: number;
  wobble: number;
  spikes: number;
  spikeLength: number;
  lightness: number;
  depth: number;
  eye: number;
  eyeY: number;
  blush: number;
  surface: number;
}

export const MAX_COMPANIONS = 3;
const TAU = Math.PI * 2;

export interface CompanionView {
  width: number;
  height: number;
  ratio: number;
  palette: readonly [OKLab, OKLab];
}

interface Placement {
  x: number;
  y: number;
  scale: number;
  front: boolean;
  squash: number;
  rotation: number;
  index: number;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function traits(config: CompanionConfig) {
  const random = mulberry32(config.seed);
  return Array.from({ length: MAX_COMPANIONS }, () => ({
    phase: random() * TAU,
    rate: 0.8 + random() * 0.4,
    spin: random() * TAU,
    wander: [random() * TAU, random() * TAU, 0.6 + random() * 0.8] as const,
    blink: random() * 5,
  }));
}

function place(
  config: CompanionConfig,
  t: number,
  view: CompanionView,
  trait: ReturnType<typeof traits>[number],
  index: number,
  count: number,
): Placement {
  const cx = view.width / 2;
  const cy = view.height * 0.52;
  const r = Math.min(view.width, view.height) * 0.3;
  const slot = (index / count) * TAU * config.spread;
  if (
    config.mode === "head" ||
    config.mode === "sides" ||
    config.mode === "climb"
  )
    return perch(config, t, view, trait, index, count);
  let angle: number;
  let reach = 1;
  let lift = config.bob * Math.sin(t * config.bobSpeed + trait.phase);
  let squash = 0;
  if (config.mode === "orbit") {
    angle = slot + trait.phase * 0.15 + t * config.speed;
  } else if (config.mode === "wander") {
    const [a, b, c] = trait.wander;
    const drift =
      Math.sin(t * config.speed * c + a) * 0.9 +
      Math.sin(t * config.speed * 0.37 + b) * 0.6;
    angle = slot + trait.phase + drift;
    reach = 0.85 + 0.15 * Math.sin(t * config.speed * 1.3 + b);
  } else {
    angle = Math.PI * (0.18 + (0.64 * (index + 0.5)) / count);
    const beat = Math.sin(
      t * config.bobSpeed - (index * TAU) / Math.max(count, 2),
    );
    const hop = Math.max(0, beat) ** 2;
    lift = -config.bob * 2.4 * hop;
    squash = hop > 0.02 ? 0 : -0.25 * Math.max(0, -beat);
  }
  const depth = Math.sin(angle);
  const scale = 1 + config.depth * depth * 0.3;
  const size = config.size * r * scale;
  const x = cx + Math.cos(angle) * config.radiusX * r * reach;
  const y = cy + depth * config.radiusY * r * reach + lift * r;
  return {
    x: Math.min(view.width - size * 1.4, Math.max(size * 1.4, x)),
    y: Math.min(view.height - size * 1.4, Math.max(size * 1.4, y)),
    scale,
    front: config.mode === "hop" || depth >= 0,
    squash,
    rotation: 0,
    index,
  };
}

function perch(
  config: CompanionConfig,
  t: number,
  view: CompanionView,
  trait: ReturnType<typeof traits>[number],
  index: number,
  count: number,
): Placement {
  const cx = view.width / 2;
  const cy = view.height * 0.52;
  const r = Math.min(view.width, view.height) * 0.3;
  const size = config.size * r;
  const beat = Math.sin(t * config.bobSpeed * trait.rate + trait.phase);
  let angle: number;
  let lift = config.bob * Math.max(0, beat) ** 2;
  let wiggle = 0;
  if (config.mode === "head") {
    const spacing = 0.5 * config.spread;
    angle =
      -Math.PI / 2 +
      (index - (count - 1) / 2) * spacing +
      0.16 * Math.sin(t * config.speed * trait.rate + trait.phase);
    lift *= 2.4;
  } else if (config.mode === "sides") {
    const left = index % 2 === 0;
    const base = index === 2 ? -0.55 : 0.12;
    const climb =
      0.38 *
      config.spread *
      Math.sin(t * config.speed * trait.rate + trait.phase);
    angle = left ? Math.PI - base - climb : base + climb;
    wiggle = 0.28 * Math.sin(t * config.bobSpeed * 1.4 + trait.phase);
    lift *= 0.8;
  } else {
    const sweep = 1.35 * config.spread;
    angle =
      -Math.PI / 2 +
      sweep *
        Math.sin(
          t * config.speed * 0.5 + (index * TAU) / count + trait.phase * 0.15,
        );
    lift *= 1.6 * Math.max(0, -Math.sin(angle));
  }
  const reach = r * config.surface + size * 0.72 + lift * r;
  const x = cx + Math.cos(angle) * reach;
  const y = cy + Math.sin(angle) * reach;
  const landing = beat < -0.85 ? (beat + 0.85) * 1.2 : 0;
  return {
    x: Math.min(view.width - size * 1.3, Math.max(size * 1.3, x)),
    y: Math.min(view.height - size * 1.3, Math.max(size * 1.3, y)),
    scale: 1,
    front: true,
    squash: landing,
    rotation: angle + Math.PI / 2 + wiggle,
    index,
  };
}

function drawOne(
  ctx: CanvasRenderingContext2D,
  config: CompanionConfig,
  t: number,
  view: CompanionView,
  trait: ReturnType<typeof traits>[number],
  at: Placement,
): void {
  const r = Math.min(view.width, view.height) * 0.3;
  const size = config.size * r * at.scale;
  const [c1, c2] = view.palette;
  const light: OKLab = [c1[0] + config.lightness, c1[1], c1[2]];
  const dark: OKLab = [c2[0] + config.lightness, c2[1], c2[2]];
  const sx = 1 - at.squash * 0.6;
  const sy = 1 + at.squash;
  ctx.save();
  ctx.translate(at.x, at.y);
  ctx.rotate(at.rotation);
  ctx.scale(sx, sy);
  const body = new Path2D();
  for (let i = 0; i <= 96; i++) {
    const theta = (i / 96) * TAU;
    const wobble =
      1 + config.wobble * 0.08 * Math.sin(theta * 3 + t * 2.2 + trait.phase);
    const spike =
      config.spikeLength *
      Math.max(0, Math.cos(config.spikes * (theta - trait.spin - t * 0.6))) **
        4;
    const radius = size * (wobble + spike);
    const x = Math.cos(theta) * radius;
    const y = Math.sin(theta) * radius;
    if (i === 0) body.moveTo(x, y);
    else body.lineTo(x, y);
  }
  body.closePath();
  ctx.shadowColor = rgb(dark, 0.35);
  ctx.shadowBlur = size * 0.6 * view.ratio;
  const fill = ctx.createRadialGradient(
    -size * 0.35,
    -size * 0.4,
    size * 0.1,
    0,
    0,
    size * 1.3,
  );
  fill.addColorStop(0, rgb(light));
  fill.addColorStop(1, rgb(dark));
  ctx.fillStyle = fill;
  ctx.fill(body);
  ctx.shadowBlur = 0;
  const blinkPhase = (t + trait.blink) % 4.6;
  const open = blinkPhase > 4.45 ? 0.15 : 1;
  if (config.blush > 0) {
    ctx.fillStyle = `rgba(255,120,140,${config.blush})`;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(
        side * size * 0.52,
        size * (config.eyeY + 0.2),
        size * 0.16,
        size * 0.09,
        0,
        0,
        TAU,
      );
      ctx.fill();
    }
  }
  ctx.fillStyle = "rgba(25,28,29,.84)";
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(
      side * size * 0.32,
      size * config.eyeY,
      size * 0.1 * config.eye,
      size * 0.15 * config.eye * open,
      0,
      0,
      TAU,
    );
    ctx.fill();
  }
  ctx.restore();
}

export function drawCompanions(
  back: CanvasRenderingContext2D,
  front: CanvasRenderingContext2D,
  config: CompanionConfig,
  active: number,
  t: number,
  view: CompanionView,
): void {
  for (const ctx of [back, front]) {
    ctx.setTransform(view.ratio, 0, 0, view.ratio, 0, 0);
    ctx.clearRect(0, 0, view.width, view.height);
  }
  const count = Math.max(0, Math.min(MAX_COMPANIONS, Math.round(active)));
  if (count === 0) return;
  const all = traits(config);
  const placements = all
    .slice(0, count)
    .map((trait, index) => place(config, t, view, trait, index, count))
    .sort((a, b) => a.y - b.y);
  for (const at of placements)
    drawOne(at.front ? front : back, config, t, view, all[at.index]!, at);
}
