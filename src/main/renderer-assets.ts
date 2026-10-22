import { extname, join, normalize, sep } from "node:path";

const mimeTypes: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
};

export function resolveRendererAsset(
  method: string,
  requestUrl: string,
  root: string,
): { path: string; mime: string } | undefined {
  if (method !== "GET") return undefined;
  const url = new URL(requestUrl);
  if (url.host !== "app") return undefined;
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return undefined;
  }
  const path = normalize(join(root, pathname));
  const mime = mimeTypes[extname(path)];
  if (!path.startsWith(root + sep) || !mime) return undefined;
  return { path, mime };
}
