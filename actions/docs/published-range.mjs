const WORKSPACE = "workspace:";

/**
 * The range `pnpm pack` publishes for a dependency spec: `workspace:^` and
 * `workspace:~` become `^` and `~` plus the sibling's version, `workspace:*`
 * the exact version, `workspace:<range>` the range, and any other spec itself.
 * Undefined when the spec needs a sibling version that is unknown.
 */
export function publishedRange(spec, version) {
  if (!spec.startsWith(WORKSPACE)) return spec;
  const rest = spec.slice(WORKSPACE.length);
  if (rest === "^" || rest === "~") return version && `${rest}${version}`;
  if (rest === "*") return version;
  return /^[\d^~<>=]/.test(rest) ? rest : undefined;
}
