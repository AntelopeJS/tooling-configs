import assert from "node:assert/strict";
import { after, describe, test } from "node:test";

import antiSlopPlugin from "./anti-slop/index.ts";
import guardrailsPlugin from "./guardrails/index.ts";
import { lintProject } from "./helpers/lint-project.ts";
import { rulePages, type Variant } from "./helpers/rule-pages.ts";
import { docsPointer } from "./rule-docs.ts";

const PLUGINS = [
  ["anti-slop", antiSlopPlugin],
  ["antelopejs", guardrailsPlugin],
] as const;

const rules = PLUGINS.flatMap(([plugin, { rules: byName }]) =>
  Object.entries(byName).map(([name, rule]) => ({ plugin, name, rule })),
);

const pages = rulePages();

const SECTIONS = ["What it flags", "Fix", "Example"];

describe("rule pages", () => {
  test("every page documents a rule a plugin ships, and no two rules share a name", () => {
    assert.deepEqual(
      [...pages.keys()].sort(),
      rules.map(({ name }) => name).sort(),
    );
  });

  for (const { plugin, name, rule } of rules)
    test(`${plugin}/${name} has its page and points every message at it`, () => {
      const page = pages.get(name);
      assert.ok(page);
      assert.equal(page.title, `\`${plugin}/${name}\``);
      assert.deepEqual(page.sections, SECTIONS);
      for (const variant of ["flagged", "fixed"] as const)
        assert.ok(
          page.examples.some(({ variants }) => variants.includes(variant)),
          `the Example section has no ${variant} fence`,
        );
      const messages = Object.values(rule.meta?.messages ?? {});
      assert.ok(messages.length > 0);
      for (const message of messages)
        assert.ok(message.endsWith(docsPointer(name)), message);
    });
});

/** The fields of an `oxlint -f json` diagnostic the examples read. */
interface Diagnostic {
  code?: string;
  filename?: string;
}

/** One project per variant, each rule's example files under a directory named after it. */
function lintVariant(variant: Variant) {
  const project = lintProject(true);
  after(project.remove);
  for (const [name, page] of pages)
    for (const file of page.examples)
      if (file.variants.includes(variant))
        project.write(`${name}/${file.path}`, file.source);
  const { diagnostics }: { diagnostics: Diagnostic[] } = project.run();
  const reported = new Set<string>();
  for (const { code, filename } of diagnostics) {
    const segments = filename?.split(/[\\/]/u) ?? [];
    if (code !== undefined && !segments.includes("node_modules"))
      reported.add(`${code} ${segments[0]}`);
  }
  return reported;
}

describe("rule page examples", () => {
  const flagged = lintVariant("flagged");
  const fixed = lintVariant("fixed");
  for (const { plugin, name } of rules)
    test(`${plugin}/${name} reports its flagged example and passes its fixed one`, () => {
      const key = `${plugin}(${name}) ${name}`;
      assert.ok(flagged.has(key), "the flagged example is not reported");
      assert.ok(!fixed.has(key), "the fixed example is reported");
    });
});
