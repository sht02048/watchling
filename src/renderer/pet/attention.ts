import { rgb, type OKLab } from "./color.ts";

export const attentionModes = [
  "bang",
  "interrobang",
  "question",
  "bubble",
  "kizuki",
  "ping",
] as const;
export type AttentionMode = (typeof attentionModes)[number];

export interface AttentionConfig {
  seed: number;
  mode: AttentionMode;
  size: number;
  offsetX: number;
  height: number;
  tilt: number;
  popDuration: number;
  overshoot: number;
  interval: number;
  jitter: number;
  burstDuration: number;
  burstStrength: number;
  outline: number;
  fillLightness: number;
}

export interface AttentionView {
  width: number;
  height: number;
  ratio: number;
  palette: readonly [OKLab, OKLab];
}

const TAU = Math.PI * 2;
const INK = "rgba(25,28,29,.9)";
const bursts = ["bob", "zoom", "wiggle"] as const;
type Burst = (typeof bursts)[number];

function hash(seed: number, index: number): number {
  let a = (seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0;
  a = Math.imul(a ^ (a >>> 15), a | 1);
  a ^= a + Math.imul(a ^ (a >>> 7), a | 61);
  return ((a ^ (a >>> 14)) >>> 0) / 4294967296;
}

function burstAt(
  config: AttentionConfig,
  t: number,
): { kind: Burst; u: number } | null {
  let start = config.popDuration;
  let previous = -1;
  for (let k = 1; k < 10000; k++) {
    const spread = 1 + config.jitter * (hash(config.seed, k) * 2 - 1);
    start += config.interval * spread;
    if (start > t) return null;
    let kind = Math.floor(hash(config.seed, k + 7919) * bursts.length);
    if (kind === previous) kind = (kind + 1) % bursts.length;
    previous = kind;
    if (t < start + config.burstDuration)
      return { kind: bursts[kind]!, u: (t - start) / config.burstDuration };
  }
  return null;
}

function popScale(config: AttentionConfig, t: number): number {
  if (t >= config.popDuration) return 1;
  const u = Math.max(0, t / config.popDuration);
  const rise = Math.min(1, u / 0.55);
  const settle = Math.max(0, (u - 0.55) / 0.45);
  const peak = 1 + config.overshoot;
  return u < 0.55
    ? peak * (1 - (1 - rise) ** 3)
    : peak + (1 - peak) * (1 - (1 - settle) ** 2);
}

function glyph(
  ctx: CanvasRenderingContext2D,
  text: string,
  px: number,
  fill: string,
  outline: number,
): void {
  ctx.font = `900 ${px}px ui-rounded, "SF Pro Rounded", system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.lineWidth = outline;
  ctx.strokeStyle = INK;
  ctx.strokeText(text, 0, 0);
  ctx.fillStyle = fill;
  ctx.fillText(text, 0, 0);
}

export function drawAttention(
  ctx: CanvasRenderingContext2D,
  config: AttentionConfig,
  t: number,
  view: AttentionView,
): void {
  if (t < 0) return;
  const r = Math.min(view.width, view.height) * 0.3;
  const px = config.size * r;
  const [c1] = view.palette;
  const light: OKLab = [
    c1[0] + (1 - c1[0]) * config.fillLightness,
    c1[1] * (1 - config.fillLightness),
    c1[2] * (1 - config.fillLightness),
  ];
  const fill = rgb(light);
  const outline = Math.max(1, px * config.outline);
  const burst = burstAt(config, t);
  const strength = config.burstStrength;
  const wave = burst ? Math.sin(Math.PI * burst.u) : 0;
  let x = view.width / 2 + config.offsetX * r;
  let y = view.height * 0.52 - config.height * r;
  let scale = popScale(config, t);
  let rotation = config.tilt;
  if (burst?.kind === "bob") y -= wave * strength * r * 0.35;
  if (burst?.kind === "zoom") scale *= 1 + wave * strength * 0.35;
  if (burst?.kind === "wiggle")
    rotation += Math.sin(burst.u * TAU * 2) * (1 - burst.u) * strength * 0.5;
  const half = px * 0.75 * scale;
  x = Math.min(view.width - half, Math.max(half, x));
  y = Math.min(view.height - half, Math.max(half, y));

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rotation);
  ctx.scale(scale, scale);
  if (config.mode === "bang") glyph(ctx, "!", px, fill, outline);
  else if (config.mode === "interrobang") glyph(ctx, "!?", px, fill, outline);
  else if (config.mode === "question") glyph(ctx, "?", px, fill, outline);
  else if (config.mode === "bubble") {
    const w = px * 0.95;
    const h = px * 0.85;
    ctx.beginPath();
    ctx.roundRect(-w / 2, -h / 2, w, h, h * 0.42);
    ctx.moveTo(-w * 0.12, h / 2 - 1);
    ctx.lineTo(-w * 0.3, h / 2 + h * 0.32);
    ctx.lineTo(w * 0.08, h / 2 - 1);
    ctx.fillStyle = "rgba(255,255,255,.96)";
    ctx.lineWidth = outline * 0.8;
    ctx.strokeStyle = INK;
    ctx.lineJoin = "round";
    ctx.stroke();
    ctx.fill();
    glyph(ctx, "!", px * 0.62, fill, outline * 0.7);
  } else if (config.mode === "kizuki") {
    ctx.translate(0, px * 0.6);
    ctx.lineCap = "round";
    for (const [angle, length] of [
      [-0.55, 0.5],
      [0, 0.62],
      [0.55, 0.5],
    ] as const) {
      const reach = px * length;
      const sx = Math.sin(angle) * px * 0.3;
      const sy = -Math.cos(angle) * px * 0.3;
      const ex = Math.sin(angle) * (px * 0.3 + reach);
      const ey = -Math.cos(angle) * (px * 0.3 + reach);
      ctx.strokeStyle = INK;
      ctx.lineWidth = outline + px * 0.16;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      ctx.strokeStyle = fill;
      ctx.lineWidth = px * 0.16;
      ctx.stroke();
    }
  } else {
    const ring = burst
      ? burst.u
      : t < config.popDuration
        ? t / config.popDuration
        : 1;
    if (ring < 1) {
      ctx.beginPath();
      ctx.arc(0, 0, px * (0.22 + ring * 0.6), 0, TAU);
      ctx.strokeStyle = rgb(view.palette[1], 0.6 * (1 - ring));
      ctx.lineWidth = px * 0.1;
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(0, 0, px * 0.22, 0, TAU);
    ctx.fillStyle = fill;
    ctx.lineWidth = outline;
    ctx.strokeStyle = INK;
    ctx.stroke();
    ctx.fill();
  }
  ctx.restore();
}
