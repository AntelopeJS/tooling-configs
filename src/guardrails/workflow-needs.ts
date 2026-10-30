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

function neededIds(job: YAMLMap): string[] {
  const needs = job.get("needs", true);
  const entries = isSeq(needs) ? needs.items : [needs];
  return entries.flatMap((entry) =>
    isScalar(entry) ? [String(entry.value)] : [],
  );
}

function isText(value: unknown): value is string {
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

function referencedIds(job: YAMLMap): string[] {
  return expressionsOf(job).flatMap((expression) =>
    [...expression.matchAll(NEEDS_REFERENCE)].map(
      ([, dotted, , quoted]) => dotted ?? quoted,
    ),
  );
}

/**
 * Lists every `needs:` entry naming no job and every `needs.<id>` or `needs['<id>']` read in a job's `if:` or `${{ }}`
 * expressions whose id is not in that job's `needs:`. GitHub evaluates such a read to null, so a gate condition like
 * `needs.checks.result == 'skipped'` silently stops failing once the job it named was renamed.
 */
export function staleNeeds(document: Document, path: string): string[] {
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
          `${path}: job ${name} needs ${id}, but no job ${id} exists. Replace it with the job id it was renamed to (the ci-node.yml caller is ci), then rerun antelopejs-sync --check.`,
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
