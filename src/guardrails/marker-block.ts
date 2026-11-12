/** A generated README block: its marker name and the comments that open and close it. */
export interface MarkedBlock {
  name: string;
  start: string;
  end: string;
}

/** The comment pair sync writes a generated block between. */
export function markers(name: string): MarkedBlock {
  return {
    name,
    start: `<!-- ${name}:start -->`,
    end: `<!-- ${name}:end -->`,
  };
}

/** The README with `block` between its markers. A README without markers comes back as it is. */
export function placeMarkedBlock(
  current: string,
  { name, start, end }: MarkedBlock,
  block: string,
): string {
  const starts = current.split(start).length - 1;
  const ends = current.split(end).length - 1;
  if (starts === 0 && ends === 0) return current;
  const from = current.indexOf(start);
  const to = current.indexOf(end);
  if (starts !== 1 || ends !== 1 || to < from)
    throw new Error(
      `invalid ${name} markers: a README holds exactly one start marker followed by one end marker. Repair or delete them, then rerun antelopejs-sync.`,
    );
  return `${current.slice(0, from)}${block}${current.slice(to + end.length).replace(/^\r?\n/, "")}`;
}
