/**
 * The label GitHub resolves a runs-on expression to, for the expressions sync writes: `vars` and the event's visibility
 * substituted, `||` and `&&` with GitHub's falsy empty string and null.
 */
export function resolve(
  expression: string,
  {
    visibility,
    vars = {},
    os,
  }: { visibility?: string; vars?: Record<string, string>; os?: string },
): string {
  const body = expression.replace(/^\$\{\{\s*|\s*\}\}$/g, "");
  const js = body
    .replace(/vars\.(\w+)/g, (_m, name: string) =>
      JSON.stringify(Object.hasOwn(vars, name) ? vars[name] : ""),
    )
    .replace(
      /github\.event\.repository\.visibility/g,
      JSON.stringify(visibility ?? null),
    )
    .replace(/matrix\.os/g, JSON.stringify(os ?? ""))
    .replaceAll("'", '"');
  return String(new Function(`return (${js});`)());
}
