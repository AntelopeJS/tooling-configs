import { isMap, isScalar, type YAMLMap } from "yaml";

/** Whether the caller asks for Windows beyond the default: any `windows` value but an opt-out `false`, or Windows on pull requests. */
function asksForWindows(inputs: YAMLMap, key: string): boolean {
  return (
    key === "windows-pull-requests" ||
    (key === "windows" && inputs.get("windows") !== false)
  );
}

/** Drops the Windows inputs of every caller in `callers`, and its `with` map when none else is left; whether anything changed. */
export function dropWindows(
  jobs: YAMLMap,
  callers: readonly { id: string }[],
): boolean {
  let changed = false;
  for (const { id } of callers) {
    const inputs = jobs.getIn([id, "with"], true);
    if (!isMap(inputs)) continue;
    const before = inputs.items.length;
    inputs.items = inputs.items.filter(
      ({ key }) =>
        !(isScalar(key) && asksForWindows(inputs, String(key.value))),
    );
    if (inputs.items.length === before) continue;
    if (!inputs.items.length) jobs.deleteIn([id, "with"]);
    changed = true;
  }
  return changed;
}
