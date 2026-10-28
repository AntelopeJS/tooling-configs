type Version = readonly [number, number, number];

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)/;

function parse(text: string): Version | undefined {
  const match = VERSION.exec(text.trim());
  return match
    ? [Number(match[1]), Number(match[2]), Number(match[3])]
    : undefined;
}

function compare(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function caret(floor: Version): Version {
  if (floor[0] > 0) return [floor[0] + 1, 0, 0];
  return floor[1] > 0 ? [0, floor[1] + 1, 0] : [0, 0, floor[2] + 1];
}

function comparator(term: string, version: Version): boolean {
  const operator = /^(>=|<=|>|<|=|\^|~)?\s*(.*)$/.exec(term.trim());
  const bound = parse(operator?.[2] ?? "");
  if (!operator || !bound) return true;
  switch (operator[1]) {
    case ">=":
      return compare(version, bound) >= 0;
    case ">":
      return compare(version, bound) > 0;
    case "<=":
      return compare(version, bound) <= 0;
    case "<":
      return compare(version, bound) < 0;
    case "^":
      return compare(version, bound) >= 0 && compare(version, caret(bound)) < 0;
    case "~":
      return (
        compare(version, bound) >= 0 &&
        compare(version, [bound[0], bound[1] + 1, 0]) < 0
      );
    default:
      return compare(version, bound) === 0;
  }
}

/** Whether a plain npm range (`^`, `~`, comparators, `||`, `*`) admits a release; wildcards and tags admit everything. */
export function admits(range: string, release: string): boolean {
  const version = parse(release);
  if (!version) return true;
  return range.split("||").some((alternative) => {
    const terms = alternative
      .replace(/(>=|<=|>|<|=|\^|~)\s+/g, "$1")
      .trim()
      .split(/\s+/);
    return terms.every((term) => comparator(term, version));
  });
}
