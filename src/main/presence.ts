export type Presence = "shown" | "dimmed" | "hidden";
export type Activity = "active" | "waiting" | "idle" | "empty";

export const DIMMED_OPACITY = 0.35;
// Peep falls asleep in the renderer (after 3 minutes idle, 10 waiting), then fades.
export const DIM_DELAY_MS = 210_000;
export const WAITING_DIM_DELAY_MS = 630_000;
export const HIDE_DELAY_MS = 180_000;

export function presence(options: {
  hidden: boolean;
  activity: Activity;
  hideWhenEmpty: boolean;
  dimWhenIdle: boolean;
  peeking: boolean;
}): Presence {
  if (options.hidden) return "hidden";
  if (options.activity === "active" || options.peeking) return "shown";
  if (options.activity === "empty" && options.hideWhenEmpty) return "hidden";
  return options.dimWhenIdle ? "dimmed" : "shown";
}
