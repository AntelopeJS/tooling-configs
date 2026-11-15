/**
 * Throws unless `version`, the version of the `typescript` the pack resolves, is TypeScript 6, the compiler API every
 * analysis of the pack is written against. The pack depends on `typescript` ^6, so only an override of `typescript` in
 * the project that installs it, which package managers apply to the pack's dependency too, yields another version; the
 * message names the override that exempts the pack under each package manager.
 */
export function requireTypeScript6(version: string): void {
  if (version.startsWith("6.")) return;
  throw new Error(
    [
      `@antelopejs/tooling-configs needs TypeScript 6 for its analyses, but the typescript it resolves is ${version}, most likely forced by an override of typescript in this project. Exempt the pack from it, then install again:`,
      `  npm or bun, package.json: "overrides": { "@antelopejs/tooling-configs": { "typescript": "^6.0.2" } }`,
      `  pnpm, pnpm-workspace.yaml: overrides: { "@antelopejs/tooling-configs>typescript": "^6.0.2" }`,
      `  yarn 1, package.json: "resolutions": { "**/@antelopejs/tooling-configs/typescript": "^6.0.2" }, as the first key: yarn 1 applies the first that matches`,
    ].join("\n"),
  );
}
