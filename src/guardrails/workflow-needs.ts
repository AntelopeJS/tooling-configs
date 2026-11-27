import {
  isMap,
  isPair,
  isScalar,
  isSeq,
  visit,
  type Document,
  type YAMLMap,
} from "yaml";

const NEEDS_REFERENCE =
  /(?<![\w.'"-])needs(?:\.([A-Za-z_][\w-]*)|\[\s*(['"])([^'"]+)\2\s*\])/g;

/** The job ids `job` lists under `needs:`, whether a single id or a list. */
export function neededIds(job: YAMLMap): string[] {
  const needs = job.get("needs", true);
  const entries = isSeq(needs) ? needs.items : [needs];
  return entries.flatMap((entry) =>
    isScalar(entry) ? [String(entry.value)] : [],
  );
}

/** Whether `value` is a string. */
export function isText(value: unknown): value is string {
  return String(value) === value;
}

function expressionsOf(job: YAMLMap): string[] {
  const expressions: string[] = [];
  visit(job, {
    Scalar(key, node, path) {
      if (key === "key") return;
      const text = node.value;
      if (!isText(text)) return;
      const parent = path.at(-1);
      if (isPair(parent) && isScalar(parent.key) && parent.key.value === "if")
        expressions.push(text);
      else expressions.push(...(text.match(/\$\{\{[\s\S]*?\}\}/g) ?? []));
    },
  });
  return expressions;
}

/** The ids `job` reads as `needs.<id>` or `needs['<id>']` in its `if:` conditions and `${{ }}` expressions. */
export function referencedIds(job: YAMLMap): string[] {
  return expressionsOf(job).flatMap((expression) =>
    [...expression.matchAll(NEEDS_REFERENCE)].map(
      ([, dotted, , quoted]) => dotted ?? quoted,
    ),
  );
}

/**
 * Lists every `needs:` entry naming no job and every `needs.<id>` or `needs['<id>']` read in a job's `if:` or `${{ }}`
 * expressions whose id is not in that job's `needs:`. GitHub evaluates such a read to null, so a gate condition like
 * `needs.checks.result == 'skipped'` silently stops failing once the job it named was renamed. `removed` lists job ids
 * the caller just deleted, so a `needs:` on one gets a message that says it was removed, not renamed.
 */
export function staleNeeds(
  document: Document,
  path: string,
  removed: readonly string[] = [],
): string[] {
  const jobs = document.get("jobs", true);
  if (!isMap(jobs)) return [];
  const ids = new Set(
    jobs.items.flatMap(({ key }) => (isScalar(key) ? [String(key.value)] : [])),
  );
  const problems: string[] = [];
  for (const { key, value: job } of jobs.items) {
    if (!isScalar(key) || !isMap(job)) continue;
    const name = String(key.value);
    const needed = neededIds(job);
    for (const id of needed)
      if (!ids.has(id))
        problems.push(
          removed.includes(id)
            ? `${path}: job ${name} needs ${id}, but sync removes the job ${id} because it only re-aggregates ci, which already reports ci / checks. Replace ${id} with ci in the needs: of ${name}, then rerun antelopejs-sync.`
            : `${path}: job ${name} needs ${id}, but no job ${id} exists. Replace it with the job id it was renamed to (the ci-node.yml caller is ci), then rerun antelopejs-sync --check.`,
        );
    const listed = `[${needed.join(", ")}]`;
    for (const id of new Set(referencedIds(job)))
      if (!needed.includes(id))
        problems.push(
          `${path}: job ${name} reads needs.${id}, but ${id} is not in its needs: ${listed}, so the read is always null. Read needs.<id> of a job in that list (the ci-node.yml caller is needs.ci), or add ${id} to needs, then rerun antelopejs-sync --check.`,
        );
  }
  return problems;
}

function renameNeeds(document: Document, from: string, to: string): void {
  const jobs = document.get("jobs", true);
  if (!isMap(jobs)) return;
  for (const { value: job } of jobs.items) {
    if (!isMap(job)) continue;
    const needs = job.get("needs", true);
    if (isScalar(needs) && needs.value === from) needs.value = to;
    if (isSeq(needs))
      for (const entry of needs.items)
        if (isScalar(entry) && entry.value === from) entry.value = to;
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renameNeedsReferences(text: string, from: string, to: string): string {
  const id = escapeRegExp(from);
  const reference = new RegExp(
    `(?<![\\w.'"-])needs(?:\\.${id}(?![\\w-])|\\[\\s*(['"])${id}\\1\\s*\\])`,
    "g",
  );
  return text.replace(reference, (_match, quote?: string) =>
    quote === undefined ? `needs.${to}` : `needs[${quote}${to}${quote}]`,
  );
}

function renameNeedsExpressions(
  document: Document,
  from: string,
  to: string,
): void {
  visit(document, {
    Scalar(key, node, path) {
      if (key === "key" || !isText(node.value)) return;
      const parent = path.at(-1);
      const wholeExpression =
        isPair(parent) && isScalar(parent.key) && parent.key.value === "if";
      node.value = wholeExpression
        ? renameNeedsReferences(node.value, from, to)
        : node.value.replace(/\$\{\{[\s\S]*?\}\}/g, (expression) =>
            renameNeedsReferences(expression, from, to),
          );
    },
  });
}

/** Renames the job `from` to `to` in every `needs` list and every `needs.<id>` or `needs['<id>']` expression of `document`. */
export function renameJobReferences(
  document: Document,
  from: string,
  to: string,
): void {
  renameNeeds(document, from, to);
  renameNeedsExpressions(document, from, to);
}
