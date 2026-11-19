import { isMap, isScalar, Scalar, type Document, type YAMLMap } from "yaml";

function lines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** The `docs-files` lines sync computes, and how to tell whether a hand-listed path still exists. */
export interface DocsFilesPlan {
  docsFiles: readonly string[];
  exists: (path: string) => boolean;
}

function normalizePath(path: string): string {
  return path.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
}

function mergedDocsFiles(current: string[], plan: DocsFilesPlan): string[] {
  const computed = new Set(plan.docsFiles);
  const kept = current
    .map(normalizePath)
    .filter((path) => path && !computed.has(path) && plan.exists(path));
  return [...new Set([...plan.docsFiles, ...kept])];
}

function setDocsFiles(
  document: Document,
  job: YAMLMap,
  plan: DocsFilesPlan,
): boolean {
  const inputs = job.get("with", true);
  const current = isMap(inputs) ? inputs.get("docs-files", true) : undefined;
  const existing = isScalar(current) ? lines(String(current.value)) : [];
  const files = mergedDocsFiles(existing, plan);
  if (isScalar(current) && existing.join("\n") === files.join("\n"))
    return false;
  const value = new Scalar(`${files.join("\n")}\n`);
  value.type = Scalar.BLOCK_LITERAL;
  if (isMap(inputs)) inputs.set("docs-files", value);
  else job.set("with", document.createNode({ "docs-files": value }));
  return true;
}

export function setCallersDocsFiles(
  document: Document,
  jobs: YAMLMap,
  callers: readonly { id: string }[],
  plan: DocsFilesPlan | undefined,
): boolean {
  let changed = false;
  if (!plan?.docsFiles.length) return false;
  for (const { id } of callers) {
    const job = jobs.get(id, true);
    if (isMap(job)) changed = setDocsFiles(document, job, plan) || changed;
  }
  return changed;
}
