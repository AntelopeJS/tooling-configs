import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import sharp from "sharp";

import { encodeWebp } from "./browser.ts";
import { bytesOf, modifiedAt } from "./helpers/files.ts";
import { settle } from "./settle.ts";

const WIDTH = 1000;
const HEIGHT = 1000;
const OUTPUT = "docs/images/sales.webp";

function root(t: test.TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "capture-settle-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function blank(width = WIDTH, height = HEIGHT): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 20, g: 24, b: 32, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
}

/** The blank page with a red rectangle of `width` by `height` pixels in its corner. */
async function marked(width: number, height: number): Promise<Buffer> {
  const mark = await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 255, g: 0, b: 0, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
  return sharp(await blank())
    .composite([{ input: mark, left: 0, top: 0 }])
    .png()
    .toBuffer();
}

function captured(png: Buffer) {
  return { scene: "sales", output: OUTPUT, png };
}

test("write mode writes a capture that does not exist yet, creating its folder", async (t) => {
  const directory = root(t);
  const png = await blank();
  assert.equal(await settle(sharp, directory, false, captured(png)), undefined);
  assert.deepEqual(
    bytesOf(join(directory, OUTPUT)),
    await encodeWebp(sharp, png),
  );
});

test("write mode leaves a capture untouched when the new one differs by no more than 0.1% of the pixels", async (t) => {
  const directory = root(t);
  await settle(sharp, directory, false, captured(await blank()));
  const before = bytesOf(join(directory, OUTPUT));
  const modified = modifiedAt(join(directory, OUTPUT));
  assert.equal(
    await settle(sharp, directory, false, captured(await marked(25, 20))),
    undefined,
  );
  assert.deepEqual(bytesOf(join(directory, OUTPUT)), before);
  assert.equal(modifiedAt(join(directory, OUTPUT)), modified);
});

test("write mode rewrites a capture that differs by more than 0.1% of the pixels", async (t) => {
  const directory = root(t);
  await settle(sharp, directory, false, captured(await blank()));
  const changed = await marked(100, 100);
  assert.equal(
    await settle(sharp, directory, false, captured(changed)),
    undefined,
  );
  assert.deepEqual(
    bytesOf(join(directory, OUTPUT)),
    await encodeWebp(sharp, changed),
  );
});

test("write mode rewrites a capture whose size changed", async (t) => {
  const directory = root(t);
  await settle(sharp, directory, false, captured(await blank()));
  const taller = await blank(WIDTH, HEIGHT + 1);
  await settle(sharp, directory, false, captured(taller));
  assert.deepEqual(
    bytesOf(join(directory, OUTPUT)),
    await encodeWebp(sharp, taller),
  );
});

test("check mode accepts a difference within the tolerance and writes nothing", async (t) => {
  const directory = root(t);
  await settle(sharp, directory, false, captured(await blank()));
  const before = bytesOf(join(directory, OUTPUT));
  assert.equal(
    await settle(sharp, directory, true, captured(await marked(25, 20))),
    undefined,
  );
  assert.deepEqual(bytesOf(join(directory, OUTPUT)), before);
});

test("check mode names the scene and the share of pixels that differ beyond the tolerance", async (t) => {
  const directory = root(t);
  await settle(sharp, directory, false, captured(await blank()));
  const before = bytesOf(join(directory, OUTPUT));
  assert.equal(
    await settle(sharp, directory, true, captured(await marked(100, 100))),
    `scene sales: 1.00% of the pixels differ from ${OUTPUT}`,
  );
  assert.deepEqual(bytesOf(join(directory, OUTPUT)), before);
});

test("check mode asks for a run when the capture does not exist", async (t) => {
  const directory = root(t);
  assert.equal(
    await settle(sharp, directory, true, captured(await blank())),
    `scene sales: ${OUTPUT} does not exist; run antelopejs-capture`,
  );
  assert.equal(existsSync(join(directory, OUTPUT)), false);
});
