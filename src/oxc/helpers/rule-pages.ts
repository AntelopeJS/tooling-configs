import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const DOCS = new URL("../../../docs/rules/", import.meta.url);

export type Variant = "flagged" | "fixed";

/** A fenced block of a page's Example section: the file it stands for and the variants that hold it. */
interface ExampleFile {
  path: string;
  source: string;
  variants: Variant[];
}

export interface RulePage {
  title: string;
  sections: string[];
  examples: ExampleFile[];
}

const FENCE = /^```(\S*)(.*)$/u;
const LABEL = /\[([^\]]+)\]/u;

function exampleFile(info: string, source: string): ExampleFile {
  const path = LABEL.exec(info)?.[1];
  assert.ok(path, `an Example fence needs a [path] label: ${info}`);
  const flags = info.replace(LABEL, " ").split(/\s+/u);
  const variants = (["flagged", "fixed"] as const).filter((variant) =>
    flags.includes(variant),
  );
  return {
    path,
    source,
    variants: variants.length === 0 ? ["flagged", "fixed"] : variants,
  };
}

function parsePage(text: string): RulePage {
  const page: RulePage = { title: "", sections: [], examples: [] };
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = FENCE.exec(line);
    if (fence) {
      const end = lines.indexOf("```", index + 1);
      assert.ok(end > index, `unclosed fence: ${line}`);
      if (page.sections.at(-1) === "Example")
        page.examples.push(
          exampleFile(fence[2], `${lines.slice(index + 1, end).join("\n")}\n`),
        );
      index = end;
    } else if (line.startsWith("# ")) page.title = line.slice(2);
    else if (line.startsWith("## ")) page.sections.push(line.slice(3));
  }
  return page;
}

/** Every page under `docs/rules`, by the name of the rule it documents. */
export function rulePages(): Map<string, RulePage> {
  return new Map(
    readdirSync(DOCS).map((file) => [
      file.replace(/\.md$/u, ""),
      parsePage(readFileSync(new URL(file, DOCS), "utf8")),
    ]),
  );
}
