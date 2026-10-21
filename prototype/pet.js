/* Adapted from minsug.me/src/components/PetFigure.astro.
 * Original seeded silhouette, OKLab palette, spring motion and Canvas shading.
 * Renderer contract: create(canvas) -> { setState(semanticState), destroy() }.
 * No session/provider/DOM-panel knowledge belongs in this module.
 */
(function (root) {
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
  const IDLE = {
    amp: 0.03,
    speed: 0.6,
    sx: 1,
    sy: 1,
    sit: 1,
    eye: 1,
    happy: 0,
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
  // Semantic states map to presentation presets, not the old demo's five labels.
  const POSES = {
    idle: IDLE,
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
    attention: {
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
  const lch = (l, c, h) => [
    l,
    c * Math.cos((h * Math.PI) / 180),
    c * Math.sin((h * Math.PI) / 180),
  ];
  const PALETTE = {
    idle: [lch(0.88, 0.07, 60), lch(0.74, 0.14, 25)],
    working: [lch(0.88, 0.07, 215), lch(0.7, 0.12, 255)],
    attention: [lch(0.92, 0.1, 85), lch(0.76, 0.16, 45)],
    unknown: [lch(0.87, 0.025, 295), lch(0.72, 0.045, 285)],
  };
  const HARMONICS = [
    [2, 0.55, 1, 0],
    [3, 0.35, -1.3, 1.7],
    [4, 0.25, 1.7, 4.1],
    [5, 0.15, -2.3, 2.2],
  ];
  const wobble = (theta, phase) =>
    HARMONICS.reduce(
      (sum, [k, a, w, p]) => sum + a * Math.sin(k * theta + phase * w + p),
      0,
    );
  function mulberry32(seed) {
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
  function rgb([l, a, b], alpha = 1) {
    const ll = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const mm = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const ss = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
    const channels = [
      4.0767416621 * ll - 3.3077115913 * mm + 0.2309699292 * ss,
      -1.2684380046 * ll + 2.6097574011 * mm - 0.3413193965 * ss,
      -0.0041960863 * ll - 0.7034186147 * mm + 1.707614701 * ss,
    ].map((x) => {
      const v =
        x <= 0.0031308
          ? 12.92 * x
          : 1.055 * Math.max(x, 0) ** (1 / 2.4) - 0.055;
      return Math.round(Math.min(1, Math.max(0, v)) * 255);
    });
    return `rgba(${channels.join(",")},${alpha})`;
  }
  function toScreen(f, u, v) {
    const x = u * f.sx,
      y = v * f.sy * (v > 0 ? 1 - 0.1 * f.sit : 1);
    const c = Math.cos(f.tilt),
      s = Math.sin(f.tilt);
    return [x * c - y * s + f.offX, x * s + y * c + f.offY];
  }
  function profile(x) {
    const { tip, concave } = SHAPE;
    const s =
      (Math.sqrt(x * x + tip * tip) - tip) / (Math.sqrt(1 + tip * tip) - tip);
    return Math.max(0, 1 - s) ** concave;
  }
  function spikeLength(f, index, theta) {
    const base =
      SHAPE.length * f.field * (1 + SHAPE.jitter * SPIKES[index % 64]);
    return Math.max(
      0,
      base *
        (1 + f.wave * 0.35 * Math.sin(f.t * 6 - index * 0.9)) *
        (1 - f.droop * 0.7 * (0.5 - 0.5 * Math.sin(theta))),
    );
  }
  function spikeRadius(f, theta) {
    const n = SHAPE.count,
      step = TAU / n;
    const t =
      theta - f.rotPhase * SHAPE.spin - ROT0 - f.droop * 0.35 * Math.cos(theta);
    const wrap = (i) => ((i % n) + n) % n;
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
  function traceBody(ctx, f, r) {
    ctx.beginPath();
    for (let i = 0; i <= 480; i++) {
      const theta = (i / 480) * TAU;
      const radius =
        CORE * (1 + f.amp * wobble(theta, f.phase)) + spikeRadius(f, theta);
      const [x, y] = toScreen(
        f,
        Math.cos(theta) * radius,
        Math.sin(theta) * radius,
      );
      if (i === 0) ctx.moveTo(x * r, y * r);
      else ctx.lineTo(x * r, y * r);
    }
    ctx.closePath();
  }
  function drawEyes(ctx, f, r) {
    const k = r * SHAPE.eyeScale * CORE;
    ctx.fillStyle = ctx.strokeStyle = "rgba(25,28,29,.84)";
    ctx.lineCap = "round";
    for (const side of [-1, 1]) {
      const u = (side * 0.3 + f.lookX * 0.1) * SHAPE.eyeScale * CORE;
      const v = (-0.1 + f.lookY * 0.1) * SHAPE.eyeScale * CORE;
      const [x, y] = toScreen(f, u, v).map((value) => value * r);
      ctx.beginPath();
      ctx.ellipse(
        x,
        y,
        0.085 * k,
        Math.max(0.018, 0.13 * f.eye) * k,
        f.tilt,
        0,
        TAU,
      );
      ctx.fill();
    }
  }
  function draw(ctx, f, width, height, ratio) {
    const r = Math.min(width, height) * 0.3;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.translate(width / 2, height * 0.52);
    ctx.save();
    traceBody(ctx, f, r);
    ctx.shadowColor = rgb(f.c2, 0.42);
    ctx.shadowBlur = r * 0.45 * ratio;
    ctx.shadowOffsetY = r * 0.08 * ratio;
    ctx.fillStyle = rgb(f.c1);
    ctx.fill();
    ctx.restore();
    ctx.save();
    traceBody(ctx, f, r);
    ctx.clip();
    const ox = f.offX * r,
      oy = f.offY * r;
    for (let i = 0; i < 3; i++) {
      const a = f.phase * (0.7 + i * 0.25) + (i * TAU) / 3;
      const bx = ox + Math.cos(a) * r * 0.45,
        by = oy + (Math.sin(a) * 0.4 + 0.15) * r;
      const color = i === 1 ? [f.c2[0] + 0.06, f.c2[1], f.c2[2]] : f.c2;
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
  }
  function create(canvas) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D is required to display the pet.");
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const spring = (v) => ({ v, vel: 0, target: v });
    const params = Object.fromEntries(
      Object.entries(IDLE).map(([key, v]) => [key, spring(v)]),
    );
    const colors = PALETTE.idle.flat().map(spring);
    let state = "idle",
      t = 0,
      phase = 0,
      rotPhase = 0,
      frame = 0,
      previous = 0;
    let width = 0,
      height = 0,
      ratio = 1,
      visible = true,
      destroyed = false;
    function render() {
      const p = Object.fromEntries(
        Object.entries(params).map(([key, s]) => [key, s.v]),
      );
      const blink = reduced.matches
        ? 0
        : Math.max(0, 1 - Math.abs((t % 4.1) - 3.8) / 0.08);
      const stretch =
        1 +
        p.breathe * 0.022 * Math.sin(t * 1.7) +
        p.pulse * 0.045 * Math.sin(t * 9);
      draw(
        ctx,
        {
          ...p,
          t,
          phase,
          sx: p.sx / Math.sqrt(stretch),
          sy: p.sy * stretch,
          tilt: p.sway * 0.1 * Math.sin(t * 0.9),
          offX: 0,
          offY: 0,
          eye: p.eye * (1 - blink * 0.92),
          rotPhase,
          c1: colors.slice(0, 3).map((s) => s.v),
          c2: colors.slice(3).map((s) => s.v),
        },
        width,
        height,
        ratio,
      );
    }
    function tick(now) {
      frame = 0;
      if (destroyed || reduced.matches || document.hidden || !visible) return;
      const dt = Math.min(1 / 30, (now - previous) / 1000);
      previous = now;
      const k = (TAU / 0.6) ** 2,
        c = (4 * Math.PI * 0.85) / 0.6;
      for (let i = 0; i < 4; i++)
        for (const s of [...Object.values(params), ...colors]) {
          s.vel += ((k * (s.target - s.v) - c * s.vel) * dt) / 4;
          s.v += (s.vel * dt) / 4;
        }
      t += dt;
      phase += params.speed.v * dt;
      rotPhase += params.rot.v * dt;
      render();
      frame = requestAnimationFrame(tick);
    }
    function start() {
      if (
        !frame &&
        !destroyed &&
        !reduced.matches &&
        visible &&
        !document.hidden
      ) {
        previous = performance.now();
        frame = requestAnimationFrame(tick);
      }
    }
    function stop() {
      cancelAnimationFrame(frame);
      frame = 0;
    }
    function setState(next) {
      root.PagentModel.assertState(next);
      state = next;
      for (const [key, value] of Object.entries(POSES[next]))
        params[key].target = value;
      PALETTE[next].flat().forEach((v, i) => {
        colors[i].target = v;
      });
      if (reduced.matches)
        for (const s of [...Object.values(params), ...colors]) {
          s.v = s.target;
          s.vel = 0;
        }
      render();
      start();
    }
    function resize() {
      const box = canvas.getBoundingClientRect();
      width = box.width;
      height = box.height;
      ratio = Math.min(devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      render();
    }
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    const intersection = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible) start();
      else stop();
    });
    intersection.observe(canvas);
    const motionChange = () => {
      stop();
      setState(state);
    };
    const visibilityChange = () => {
      if (document.hidden) stop();
      else start();
    };
    reduced.addEventListener("change", motionChange);
    document.addEventListener("visibilitychange", visibilityChange);
    resize();
    start();
    return {
      setState,
      destroy() {
        destroyed = true;
        stop();
        observer.disconnect();
        intersection.disconnect();
        reduced.removeEventListener("change", motionChange);
        document.removeEventListener("visibilitychange", visibilityChange);
      },
    };
  }
  root.PagentPet = Object.freeze({ id: "original", name: "가시", create });
})(globalThis);
