export const modes = ["real", "toy", "dev"] as const;
export type Mode = (typeof modes)[number];

export interface Config {
  mode: Mode;
  typeSpeed: number;
  agentDurations: [number, number];
  peepSize: number;
  desktopPeepSize: number;
  wallpaperHue: number;
}

type NumberKnob = Exclude<keyof Config, "mode" | "agentDurations">;

const ranges: Record<
  NumberKnob | "agentDuration",
  { min: number; max: number; step: number }
> = {
  typeSpeed: { min: 80, max: 1200, step: 20 },
  agentDuration: { min: 1, max: 20, step: 0.5 },
  peepSize: { min: 140, max: 300, step: 2 },
  desktopPeepSize: { min: 140, max: 320, step: 2 },
  wallpaperHue: { min: 0, max: 360, step: 1 },
};

const inRange = (value: unknown, key: keyof typeof ranges): boolean => {
  const { min, max, step } = ranges[key];
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max &&
    (step < 1 || Number.isInteger(value))
  );
};

export function validateConfig(value: unknown): Config | null {
  if (value === null || typeof value !== "object") return null;
  const config = value as Record<string, unknown>;
  const durations = config.agentDurations;
  const valid =
    Object.keys(config).length === Object.keys(ranges).length + 1 &&
    modes.includes(config.mode as Mode) &&
    Array.isArray(durations) &&
    durations.length === 2 &&
    durations.every((duration) => inRange(duration, "agentDuration")) &&
    (Object.keys(ranges) as (keyof typeof ranges)[])
      .filter((key) => key !== "agentDuration")
      .every((key) => inRange(config[key], key));
  return valid ? (config as unknown as Config) : null;
}
