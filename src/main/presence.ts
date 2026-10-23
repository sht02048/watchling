export type Presence = "shown" | "dimmed" | "hidden";
export type Activity = "active" | "idle" | "empty";

export const DIMMED_OPACITY = 0.35;
// Long enough to still see Peep turn coral when a turn finishes.
export const IDLE_DELAY_MS = 5000;

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
