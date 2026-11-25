import { gunzipSync } from "node:zlib";

const TAR_BLOCK = 512;

/** The text of the entry `path` in the gzipped tar archive `tarball`, read in Node so no `tar` binary, which differs across platforms, is needed. */
export function tarEntry(
  tarball: Uint8Array,
  path: string,
): string | undefined {
  const archive = gunzipSync(tarball);
  for (let offset = 0; offset + TAR_BLOCK <= archive.length;) {
    const header = archive.subarray(offset, offset + TAR_BLOCK);
    const name = header.toString("utf8", 0, 100).replace(/\0.*$/s, "");
    if (!name) return undefined;
    const size = Number.parseInt(header.toString("utf8", 124, 136), 8) || 0;
    const start = offset + TAR_BLOCK;
    if (name === path) return archive.toString("utf8", start, start + size);
    offset = start + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
  }
  return undefined;
}
