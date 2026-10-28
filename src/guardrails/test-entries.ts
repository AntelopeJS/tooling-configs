/** The line a proof half prints for a published test-helper entry it leaves out, so a skip is reported rather than silent. */
export function testEntryNotice(
  half: "API" | "Runtime API",
  directory: string,
  target: string,
): string {
  return `${half}: skipped test-helper entry ${target} in ${directory}; test helpers need a test runner and are outside both proof halves.\n`;
}
