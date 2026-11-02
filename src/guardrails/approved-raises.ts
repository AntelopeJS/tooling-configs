/** The environment variable that carries the raises the operator approved. */
const APPROVED_RAISES_ENV = "APPROVED_RAISES";

const ENTRY = /^([^=\s]+)=([0-9]{1,15})$/u;

/**
 * Parses `APPROVED_RAISES`, a space-separated list of `<rule>=<max>` entries
 * where `<max>` is the ceiling the same commit writes for `<rule>`.
 * An unset or blank variable approves nothing. A bare rule, a non-numeric or
 * oversized max, or a rule listed twice makes the whole list malformed, and
 * a malformed list throws instead of approving any of its entries.
 */
export function parseApprovedRaises(
  value: string | undefined = process.env[APPROVED_RAISES_ENV],
): Map<string, number> {
  const approved = new Map<string, number>();
  for (const entry of (value ?? "").split(/\s+/u).filter(Boolean)) {
    const match = ENTRY.exec(entry);
    if (match === null || approved.has(match[1]))
      throw new Error(
        `${APPROVED_RAISES_ENV} is malformed at ${JSON.stringify(entry)}: expected space-separated <rule>=<max> entries with a whole-number max and each rule once, so nothing is approved.`,
      );
    approved.set(match[1], Number(match[2]));
  }
  return approved;
}
