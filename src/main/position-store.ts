import { isPoint, type Point } from "../shared/ui-contract.ts";
import {
  MissingFile,
  readPrivateJson,
  writePrivateJson,
} from "./private-json.ts";

export class PositionStore {
  private writes: Promise<void> = Promise.resolve();
  private readonly directory: string;
  constructor(directory: string) {
    this.directory = directory;
  }

  async load(): Promise<Point | null> {
    try {
      const value = await readPrivateJson(this.directory, "position.json", 256);
      if (isPoint(value))
        return { x: Math.round(value.x), y: Math.round(value.y) };
      console.warn("Position restore skipped: invalid coordinates");
    } catch (error) {
      if (!(error instanceof MissingFile))
        console.warn("Position restore skipped: unreadable data");
    }
    return null;
  }

  save(position: Point): Promise<void> {
    if (!isPoint(position))
      return Promise.reject(new TypeError("Invalid position"));
    this.writes = this.writes
      .then(() => writePrivateJson(this.directory, "position.json", position))
      .catch(() => {
        console.warn("Position save failed; current window remains usable");
      });
    return this.writes;
  }

  flush(): Promise<void> {
    return this.writes;
  }
}
