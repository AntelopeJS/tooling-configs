import {
  isMap,
  isNode,
  isPair,
  isScalar,
  Scalar,
  visit,
  type Document,
  type Pair,
  type YAMLMap,
} from "yaml";

/** A source line under a key: a comment, or a blank line when `text` is undefined. */
interface SourceLine {
  column: number;
  text: string | undefined;
}

/** Comment lines as the `yaml` model stores them, with whether a blank line precedes and follows them. */
interface CommentBlock {
  comment: string;
  blankBefore: boolean;
  blankAfter: boolean;
}

function sourceLines(source: string) {
  const [first = "", ...rest] = source.split(/\r?\n/);
  const hash = first.indexOf("#");
  const below = rest.slice(0, -1).map((line): SourceLine => {
    const trimmed = line.trimStart();
    return {
      column: line.length - trimmed.length,
      text: trimmed ? trimmed.replace(/^#/, "") : undefined,
    };
  });
  return { inline: hash === -1 ? undefined : first.slice(hash + 1), below };
}

/** Where the first comment matching `starts` begins, the blank lines before it included. */
function cut(lines: SourceLine[], starts: (column: number) => boolean): number {
  let index = lines.findIndex(
    ({ column, text }) => text !== undefined && starts(column),
  );
  if (index === -1) return lines.length;
  while (index > 0 && lines[index - 1].text === undefined) index -= 1;
  return index;
}

function commentBlock(lines: SourceLine[]): CommentBlock | undefined {
  const start = lines.findIndex(({ text }) => text !== undefined);
  if (start === -1) return undefined;
  let end = lines.length;
  while (lines[end - 1].text === undefined) end -= 1;
  return {
    comment: lines
      .slice(start, end)
      .map(({ text }) => text ?? "")
      .join("\n"),
    blankBefore: start > 0,
    blankAfter: end < lines.length,
  };
}

function scalarKey(pair: Pair): Scalar | undefined {
  if (isScalar(pair.key)) return pair.key;
  if (isNode(pair.key)) return undefined;
  const key = new Scalar(pair.key);
  pair.key = key;
  return key;
}

function followingKey(path: readonly unknown[]): Scalar | undefined {
  for (let index = path.length - 1; index > 0; index -= 2) {
    const pair = path[index];
    const map = path[index - 1];
    if (!isPair(pair) || !isMap(map)) return undefined;
    const next = map.items[map.items.indexOf(pair) + 1];
    if (next) return scalarKey(next);
  }
  return undefined;
}

function withBlankAfter(block: CommentBlock): string {
  return block.blankAfter ? `${block.comment}\n` : block.comment;
}

function placeBefore(key: Scalar | undefined, block: CommentBlock): boolean {
  if (key === undefined) return false;
  key.commentBefore = [withBlankAfter(block), key.commentBefore]
    .filter((comment) => comment !== undefined)
    .join("\n");
  key.spaceBefore = block.blankBefore || undefined;
  return true;
}

function placeAfter(map: YAMLMap, block: CommentBlock): void {
  map.comment = [map.comment, withBlankAfter(block)]
    .filter((comment) => comment !== undefined)
    .join("\n");
}

function columnOf(text: string, offset: number): number {
  return offset - (text.lastIndexOf("\n", offset - 1) + 1);
}

/**
 * Splits the comment lines under a key into those indented under it, those at its column, which belong before the next
 * key, and, when the key is its map's last, those dedented past it, which belong to an enclosing map.
 */
function partition(below: SourceLine[], keyColumn: number, hasNext: boolean) {
  const shallow = cut(below, (column) => column <= keyColumn);
  const dedented = hasNext
    ? below.length
    : Math.max(
        cut(below, (column) => column < keyColumn),
        shallow,
      );
  return {
    deep: commentBlock(below.slice(0, shallow)),
    sibling: commentBlock(below.slice(shallow, dedented)),
    outer: commentBlock(below.slice(dedented)),
  };
}

/** The comment lines `yaml` gave the empty value of the map's `index`th pair, read back from `text`. */
function emptyValueComments(map: YAMLMap, index: number, text: string) {
  const { key, value } = map.items[index];
  if (!isScalar(value) || value.value !== null || value.comment === undefined)
    return undefined;
  const keyStart = isScalar(key) ? key.range?.[0] : undefined;
  const [, valueEnd, nodeEnd] = value.range ?? [];
  if (keyStart === undefined || valueEnd === undefined) return undefined;
  const next = map.items.at(index + 1);
  const nextKey = next && scalarKey(next);
  const { inline, below } = sourceLines(
    text.slice(valueEnd, nextKey?.range?.[0] ?? nodeEnd),
  );
  return {
    value,
    nextKey,
    inline,
    ...partition(below, columnOf(text, keyStart), next !== undefined),
  };
}

function restorePair(
  map: YAMLMap,
  index: number,
  path: readonly unknown[],
  text: string,
): void {
  const found = emptyValueComments(map, index, text);
  if (!found || (!found.sibling && !found.outer)) return;
  const { value, nextKey, inline, deep, sibling, outer } = found;
  if (nextKey) nextKey.commentBefore = undefined;
  value.spaceBefore = undefined;
  value.comment =
    [inline, deep?.comment].filter((line) => line !== undefined).join("\n") ||
    undefined;
  if (sibling && !placeBefore(nextKey, sibling)) placeAfter(map, sibling);
  if (outer && !placeBefore(followingKey(path), outer)) placeAfter(map, outer);
}

/**
 * The `yaml` parser hands the first comment line under a key with an empty value, such as `workflow_dispatch:`, to that
 * value as its trailing comment, so a rewrite prints it on the key's line and splits the comment block with a blank
 * line. This reads the comment lines back from `text`, the source `document` was parsed from, and places them by
 * column: lines indented under the key stay with its value, lines at the key's column go before the next key or, under
 * a map's last key, after the map, and lines dedented past the key go before the next key of an enclosing map.
 */
export function restoreEmptyValueComments(
  document: Document,
  text: string,
): void {
  visit(document, {
    Map(_key, map, path) {
      for (const index of map.items.keys()) restorePair(map, index, path, text);
    },
  });
}
