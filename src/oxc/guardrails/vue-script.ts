import { readFileSync } from "node:fs";

const BLOCK =
  /<!--[\s\S]*?-->|(<script\b(?:"[^"]*"|'[^']*'|[^>"'])*>)([\s\S]*?)(?=<\/script\s*>)/giu;

const GENERIC = /\sgeneric\s*=/iu;

const MODULE = "\nexport {};\n";

function blank(text: string): string {
  return Array.from(text, (character) =>
    character === "\n" || character === "\r"
      ? character
      : " ".repeat(character.length),
  ).join("");
}

/**
 * A Vue single-file component as TypeScript reads it: the contents of its
 * `<script>` and `<script setup>` blocks, every other character a space and
 * every line break kept, so an offset or a line is the same in the component,
 * then an `export {}`, as Vue compiles every component to a module. Undefined
 * when the text holds no script block, as oxlint passes a component's script
 * alone.
 */
export function scriptView(sfc: string): string | undefined {
  let view = "";
  let end = 0;
  for (const { 1: open, 2: content, index } of sfc.matchAll(BLOCK)) {
    if (open === undefined || content === undefined) continue;
    const start = index + open.length;
    view += blank(sfc.slice(end, start)) + content;
    end = start + content.length;
  }
  return end === 0 ? undefined : `${view}${blank(sfc.slice(end))}${MODULE}`;
}

/** A linted file as the type checker reads it, and the offset of the linted text in it. */
export interface LintedSource {
  text: string;
  offset: number;
}

/**
 * The text to type for a linted file. A component whose linted text holds no
 * script block, as oxlint passes a component's script alone, is read whole
 * from disk, and `offset` is where that script starts inside the block whose
 * contents it is, which oxlint passes trimmed. Undefined for a component with no such block, or that
 * declares `generic` type parameters.
 */
export function lintedSource(
  filename: string,
  text: string,
): LintedSource | undefined {
  if (!filename.endsWith(".vue")) return { text, offset: 0 };
  if (scriptView(text) !== undefined)
    return declaresTypeParameters(text) ? undefined : { text, offset: 0 };
  const component = readFileSync(filename, "utf8");
  const block = Array.from(component.matchAll(BLOCK)).find(
    ({ 1: open, 2: content }) =>
      open !== undefined && content?.trim() === text.trim(),
  );
  return block?.[1] === undefined ||
    block[2] === undefined ||
    declaresTypeParameters(component)
    ? undefined
    : {
        text: component,
        offset: block.index + block[1].length + block[2].indexOf(text),
      };
}

/** Whether a script block of the component declares type parameters with `generic`, which only Vue's compiler brings into scope, so the view types them as error types. */
export function declaresTypeParameters(sfc: string): boolean {
  return Array.from(sfc.matchAll(BLOCK)).some(
    ({ 1: open }) => open !== undefined && GENERIC.test(open),
  );
}
