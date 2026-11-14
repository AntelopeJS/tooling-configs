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

/** Whether a script block of the component declares type parameters with `generic`, which only Vue's compiler brings into scope, so the view types them as error types. */
export function declaresTypeParameters(sfc: string): boolean {
  return Array.from(sfc.matchAll(BLOCK)).some(
    ({ 1: open }) => open !== undefined && GENERIC.test(open),
  );
}
