import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { bin, read, testRepo } from "./helpers/test-repo.ts";

const STRIP = ".github/readme/strip.svg";

function fontMagics(svg: string): string[] {
  return [
    ...svg.matchAll(
      /font-family:'(Geist[XM])';src:url\(data:font\/woff2;base64,([A-Za-z0-9+/=]+)\)/g,
    ),
  ].map(
    ([, family, data]) =>
      `${family}:${Buffer.from(data, "base64").subarray(0, 4).toString("latin1")}`,
  );
}

test("an interface strip carries its label, the framework blue, the hexagon, the star button and both embedded fonts", (t) => {
  const root = testRepo(t);
  const run = bin(root, "readme-strip", [
    "--kind",
    "interface",
    "--name",
    "email",
  ]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout + run.stderr, "");
  const svg = read(root, STRIP);
  assert.match(
    svg,
    /^<svg [^>]*viewBox="0 0 1200 150" width="1200" height="150"/,
  );
  assert.match(svg, /fill="#4f8cff"[^>]*>INTERFACE · EMAIL<\/text>/);
  assert.match(
    svg,
    /aria-label="INTERFACE · EMAIL: part of AntelopeJS, hexagonal architecture beyond your own code\. A glowing button reads Star AntelopeJS\."/,
  );
  assert.match(
    svg,
    />Part of <tspan fill="#4f8cff">AntelopeJS<\/tspan><\/text>/,
  );
  assert.match(
    svg,
    /<polygon points="(?:[\d.]+,[\d.]+ ){5}[\d.]+,[\d.]+" fill="#4f8cff"/,
  );
  assert.match(
    svg,
    /stroke="#4f8cff"[^>]*\/><rect [^>]*\/><text [^>]*>★ Star AntelopeJS<\/text>/,
  );
  assert.doesNotMatch(svg, /#4dd9e6|#fbbf24|DMS/);
  assert.deepEqual(fontMagics(svg), ["GeistX:wOF2", "GeistM:wOF2"]);
});

test("a provider name with hyphens reads as words in the label", (t) => {
  const root = testRepo(t);
  const run = bin(root, "readme-strip", [
    "--kind",
    "provider",
    "--name",
    "file-storage-s3",
  ]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(read(root, STRIP), />PROVIDER · FILE STORAGE S3<\/text>/);
});

const REJECTED = {
  "an unknown kind": [
    ["--kind", "module", "--name", "email"],
    /unknown strip kind "module": use one of interface, provider, template, tooling\./,
  ],
  "a name that is not lowercase words joined by hyphens": [
    ["--kind", "provider", "--name", 'x"><script>'],
    /invalid strip name/,
  ],
  "an interface name that repeats its kind": [
    ["--kind", "interface", "--name", "interface-email"],
    /strip name "interface-email" repeats the kind: pass --name email, the label reads INTERFACE · EMAIL\./,
  ],
  "a missing name": [
    ["--kind", "tooling"],
    /usage: antelopejs-readme-strip --kind <interface\|provider\|template\|tooling> --name <label-name>/,
  ],
} as const;

for (const [name, [args, message]] of Object.entries(REJECTED))
  test(`${name} fails naming the fix and writes no strip`, (t) => {
    const root = testRepo(t);
    const run = bin(root, "readme-strip", [...args]);
    assert.equal(run.status, 1);
    assert.match(run.stderr, message);
    assert.equal(existsSync(join(root, STRIP)), false);
  });
