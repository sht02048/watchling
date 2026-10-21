import { mkdir, open, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isPoint, type Point } from "../shared/ui-contract.ts";

export class PositionStore {
  private writes: Promise<void> = Promise.resolve();
  private readonly directory: string;
  constructor(directory: string) {
    this.directory = directory;
  }

  async load(): Promise<Point | null> {
    try {
      const file = await open(join(this.directory, "position.json"), "r");
      let text: string;
      try {
        const buffer = Buffer.alloc(257);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead > 256)
          throw new Error("Position data exceeds size limit");
        text = buffer.toString("utf8", 0, bytesRead);
      } finally {
        await file.close();
      }
      const value: unknown = JSON.parse(text);
      if (isPoint(value))
        return { x: Math.round(value.x), y: Math.round(value.y) };
      console.warn("Position restore skipped: invalid coordinates");
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      )) {
        console.warn("Position restore skipped: unreadable data");
      }
    }
    return null;
  }

  save(position: Point): Promise<void> {
    if (!isPoint(position))
      return Promise.reject(new TypeError("Invalid position"));
    this.writes = this.writes
      .then(async () => {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const target = join(this.directory, "position.json");
        const temporary = join(this.directory, "position.json.tmp");
        await writeFile(temporary, JSON.stringify(position), { mode: 0o600 });
        await rename(temporary, target);
      })
      .catch(() => {
        console.warn("Position save failed; current window remains usable");
      });
    return this.writes;
  }

  flush(): Promise<void> {
    return this.writes;
  }
}
