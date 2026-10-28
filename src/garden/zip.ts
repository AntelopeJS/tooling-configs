import { inflateRawSync } from "node:zlib";

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_ENTRY = 0x02014b50;

/** Reads the first file of a stored or deflated ZIP archive, as produced for an Actions artifact. */
export function firstZipEntry(archive: Uint8Array): string {
  const view = new DataView(
    archive.buffer,
    archive.byteOffset,
    archive.byteLength,
  );
  let end = archive.byteLength - 22;
  while (end >= 0 && view.getUint32(end, true) !== END_OF_CENTRAL_DIRECTORY)
    end--;
  if (end < 0) throw new Error("Not a ZIP archive.");
  const entry = view.getUint32(end + 16, true);
  if (view.getUint32(entry, true) !== CENTRAL_ENTRY)
    throw new Error("Empty ZIP archive.");
  const method = view.getUint16(entry + 10, true);
  const size = view.getUint32(entry + 20, true);
  const local = view.getUint32(entry + 42, true);
  const start =
    local +
    30 +
    view.getUint16(local + 26, true) +
    view.getUint16(local + 28, true);
  const data = archive.subarray(start, start + size);
  if (method === 0) return Buffer.from(data).toString("utf8");
  if (method === 8) return inflateRawSync(data).toString("utf8");
  throw new Error(`Unsupported ZIP method ${method}.`);
}
