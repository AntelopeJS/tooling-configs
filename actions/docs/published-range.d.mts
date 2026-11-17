/** The range `pnpm pack` publishes for a dependency spec, or undefined when a `workspace:` spec needs an unknown sibling version. */
export function publishedRange(
  spec: string,
  version: string | undefined,
): string | undefined;
