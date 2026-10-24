import { useSyncExternalStore } from "react";

export const REPO = "https://github.com/sht02048/watchling";

const RELEASES = `${REPO}/releases/latest`;
const LATEST_API =
  "https://api.github.com/repos/sht02048/watchling/releases/latest";

let download = RELEASES;
let requested = false;
const listeners = new Set<() => void>();

// Release DMGs carry the version in their name, so the latest one is looked up;
// until then, or if the lookup fails, the button opens the releases page.
async function lookUpDownload(): Promise<void> {
  try {
    const response = await fetch(LATEST_API);
    if (!response.ok) return;
    const release = (await response.json()) as {
      assets?: { name: string; browser_download_url: string }[];
    };
    const dmg = release.assets?.find((asset) => asset.name.endsWith(".dmg"));
    if (!dmg) return;
    download = dmg.browser_download_url;
    for (const listener of listeners) listener();
  } catch {
    // Keep the releases page.
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!requested) {
    requested = true;
    void lookUpDownload();
  }
  return () => listeners.delete(listener);
}

export function useDownloadUrl(): string {
  return useSyncExternalStore(subscribe, () => download);
}
