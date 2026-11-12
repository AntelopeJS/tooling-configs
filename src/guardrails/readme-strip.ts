import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { toolingRoot } from "./package.ts";

/** Where a framework repository keeps its strip banner, relative to its root. */
const STRIP_PATH = ".github/readme/strip.svg";

/** The kinds of framework repository, in the order the strip label names them. */
export const STRIP_KINDS = [
  "interface",
  "provider",
  "template",
  "tooling",
] as const;

/** What a framework repository is: an interface, a provider, a template, or tooling. */
type StripKind = (typeof STRIP_KINDS)[number];

const ACCENT = "#4f8cff";
const BORDER = "rgba(140,160,220,0.18)";
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Kinds whose repository names start with the kind, such as `interface-email`; the label names the kind once. */
const REPEATED_KINDS: ReadonlySet<string> = new Set(["interface", "template"]);
const TAGLINE = "Hexagonal architecture, beyond your own code.";
const FONTS = [
  ["GeistX", "geist-extrabold.woff2"],
  ["GeistM", "geist-mono.woff2"],
] as const;

const HEXAGON = { x: 750, y: 75, radius: 40 };
const SPOKES = [
  [0, -44, 0, -60],
  [0, 44, 0, 60],
  [38, -22, 78, -40],
  [38, 22, 78, 40],
  [-38, -22, -78, -40],
  [-38, 22, -78, 40],
] as const;

function isKind(kind: string): kind is StripKind {
  return STRIP_KINDS.some((known) => known === kind);
}

/** The label the strip shows for a repository, such as `PROVIDER · FILE STORAGE S3`. */
function stripLabel(kind: string, name: string): string {
  if (!isKind(kind))
    throw new Error(
      `unknown strip kind "${kind}": use one of ${STRIP_KINDS.join(", ")}.`,
    );
  if (!NAME.test(name))
    throw new Error(
      `invalid strip name "${name}": use lowercase words joined by hyphens, such as file-storage-s3.`,
    );
  if (REPEATED_KINDS.has(kind) && name.startsWith(`${kind}-`))
    throw new Error(
      `strip name "${name}" repeats the kind: pass --name ${name.slice(kind.length + 1)}, the label reads ${kind.toUpperCase()} · ${name
        .slice(kind.length + 1)
        .replaceAll("-", " ")
        .toUpperCase()}.`,
    );
  return `${kind} · ${name.replaceAll("-", " ")}`.toUpperCase();
}

function fontFaces(): string {
  const directory = join(toolingRoot(), "assets/readme");
  return FONTS.map(
    ([family, file]) =>
      `@font-face{font-family:'${family}';src:url(data:font/woff2;base64,${readFileSync(join(directory, file)).toString("base64")}) format('woff2')}`,
  ).join("");
}

function hexagon(): string {
  const { x, y, radius } = HEXAGON;
  const points = [-90, -30, 30, 90, 150, 210]
    .map((degrees) => {
      const angle = (degrees * Math.PI) / 180;
      return `${(x + radius * Math.cos(angle)).toFixed(1)},${(y + radius * Math.sin(angle)).toFixed(1)}`;
    })
    .join(" ");
  const spokes = SPOKES.map(
    ([x1, y1, x2, y2]) =>
      `<line x1="${x + x1}" y1="${y + y1}" x2="${x + x2}" y2="${y + y2}" stroke="${BORDER}" stroke-width="2"/><circle cx="${x + x2}" cy="${y + y2}" r="5" fill="#15151b" stroke="${BORDER}"/>`,
  ).join("");
  return `${spokes}<polygon points="${points}" fill="${ACCENT}" fill-opacity=".14" stroke="${ACCENT}" stroke-width="2"/>`;
}

/** The 1200x150 strip banner of a framework repository, in the layout and fonts of the DMS strips and the framework blue. */
function stripSvg(kind: string, name: string): string {
  const label = stripLabel(kind, name);
  const description = `${label}: part of AntelopeJS, hexagonal architecture beyond your own code. A glowing button reads Star AntelopeJS.`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 150" width="1200" height="150" role="img" aria-label="${description}"><title>${description}</title>`,
    `<style>${fontFaces()}.x{font-family:'GeistX',sans-serif;font-weight:800}.m{font-family:'GeistM',monospace}@keyframes a1{0%,8.89%{opacity:0;transform:scale(.7)}11.89%,88.00%{opacity:1;transform:none}92.00%,100%{opacity:0;transform:scale(.7)}}.a1{opacity:0;transform:scale(.7);transform-box:fill-box;transform-origin:center;animation:a1 9.0s cubic-bezier(.2,.8,.2,1) infinite}@keyframes pulse{0%,100%{opacity:.35}50%{opacity:.9}}.pulse{animation:pulse 2s ease-in-out infinite}@media (prefers-reduced-motion:reduce){*{animation:none!important;opacity:1!important}.cover{display:none}}</style>`,
    `<defs><radialGradient id="g" cx="75%" cy="50%" r="60%"><stop offset="0" stop-color="${ACCENT}" stop-opacity=".10"/><stop offset="1" stop-color="#06070d" stop-opacity="0"/></radialGradient></defs>`,
    `<rect width="1200" height="150" rx="16" fill="#06070d"/><rect width="1200" height="150" rx="16" fill="url(#g)"/><rect x=".5" y=".5" width="1199" height="149" rx="16" fill="none" stroke="${BORDER}"/>`,
    `<text x="48" y="50" class="m" fill="${ACCENT}" font-size="15" letter-spacing="3">${label}</text>`,
    `<text x="46" y="98" class="x" fill="#f8f8f9" font-size="32">Part of <tspan fill="${ACCENT}">AntelopeJS</tspan></text>`,
    `<text x="48" y="128" class="m" fill="#9b9ba4" font-size="16">${TAGLINE}</text>`,
    hexagon(),
    `<g class="a1"><rect class="pulse" x="870" y="44" width="290" height="62" rx="31" fill="none" stroke="${ACCENT}" stroke-width="2"/><rect x="876" y="50" width="278" height="50" rx="25" fill="${ACCENT}" fill-opacity=".14"/><text x="1015" y="82" text-anchor="middle" class="x" fill="${ACCENT}" font-size="20">★ Star AntelopeJS</text></g>`,
    "</svg>",
    "",
  ].join("");
}

/** Writes the strip banner of the repository at `root` to `.github/readme/strip.svg`. */
export function writeStrip(root: string, kind: string, name: string): void {
  const svg = stripSvg(kind, name);
  mkdirSync(join(root, ".github/readme"), { recursive: true });
  writeFileSync(join(root, STRIP_PATH), svg);
}
