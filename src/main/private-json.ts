import { mkdir, open, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export class MissingFile extends Error {}

export async function readPrivateJson(
  directory: string,
  name: string,
  limit: number,
): Promise<unknown> {
  let file;
  try {
    file = await open(join(directory, name), "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new MissingFile(name);
    throw error;
  }
  try {
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit) throw new Error(`${name} exceeds size limit`);
    return JSON.parse(buffer.toString("utf8", 0, bytesRead));
  } finally {
    await file.close();
  }
}

export async function writePrivateJson(
  directory: string,
  name: string,
  value: unknown,
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `${name}.tmp`);
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, join(directory, name));
}
