import { isRecord } from "../integration/claude/protocol.ts";
import {
  MissingFile,
  readPrivateJson,
  writePrivateJson,
} from "./private-json.ts";

export const petSizes = {
  small: { label: "Small", scale: 0.75 },
  medium: { label: "Medium", scale: 1 },
  large: { label: "Large", scale: 1.25 },
  "extra-large": { label: "Extra Large", scale: 1.5 },
} as const;
export type PetSize = keyof typeof petSizes;

export interface Settings {
  petSize: PetSize;
  allSpaces: boolean;
  hideWhenEmpty: boolean;
  dimWhenIdle: boolean;
  // Set once Watchling has turned on Open When Mac Starts by default, so a
  // later choice to turn it off is never undone.
  startupApplied: boolean;
}

export const defaultSettings: Settings = {
  petSize: "medium",
  allSpaces: true,
  hideWhenEmpty: true,
  dimWhenIdle: true,
  startupApplied: false,
};

function isPetSize(value: unknown): value is PetSize {
  return typeof value === "string" && Object.hasOwn(petSizes, value);
}

const flags = [
  "allSpaces",
  "hideWhenEmpty",
  "dimWhenIdle",
  "startupApplied",
] as const;

export class SettingsStore {
  private writes: Promise<void> = Promise.resolve();
  private readonly directory: string;
  constructor(directory: string) {
    this.directory = directory;
  }

  async load(): Promise<Settings> {
    try {
      const value = await readPrivateJson(
        this.directory,
        "settings.json",
        4096,
      );
      if (isRecord(value))
        return {
          petSize: isPetSize(value.petSize)
            ? value.petSize
            : defaultSettings.petSize,
          ...Object.fromEntries(
            flags.map((flag) => [
              flag,
              typeof value[flag] === "boolean"
                ? value[flag]
                : defaultSettings[flag],
            ]),
          ),
        } as Settings;
      console.warn("Settings restore skipped: invalid data");
    } catch (error) {
      if (!(error instanceof MissingFile))
        console.warn("Settings restore skipped: unreadable data");
    }
    return { ...defaultSettings };
  }

  save(settings: Settings): Promise<void> {
    if (
      !isPetSize(settings.petSize) ||
      flags.some((flag) => typeof settings[flag] !== "boolean")
    )
      return Promise.reject(new TypeError("Invalid settings"));
    const value: Settings = {
      petSize: settings.petSize,
      allSpaces: settings.allSpaces,
      hideWhenEmpty: settings.hideWhenEmpty,
      dimWhenIdle: settings.dimWhenIdle,
      startupApplied: settings.startupApplied,
    };
    this.writes = this.writes
      .then(() => writePrivateJson(this.directory, "settings.json", value))
      .catch(() => {
        console.warn("Settings save failed; current choice still applies");
      });
    return this.writes;
  }

  flush(): Promise<void> {
    return this.writes;
  }
}
