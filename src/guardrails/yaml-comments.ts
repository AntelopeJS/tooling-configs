import { isScalar, visit, type Document, type YAMLMap } from "yaml";

interface CommentBlock {
  inline: string | undefined;
  below: string[];
  blankBefore: boolean;
  blankAfter: boolean;
}

function commentBlock(source: string): CommentBlock {
  const [first = "", ...rest] = source.split("\n");
  const hash = first.indexOf("#");
  const lines = rest.map((line) => line.trim());
  const start = lines.findIndex(Boolean);
  let end = lines.length;
  while (end > 0 && !lines[end - 1]) end -= 1;
  return {
    inline: hash === -1 ? undefined : first.slice(hash + 1),
    below:
      start === -1
        ? []
        : lines
            .slice(start, end)
            .map((line) => (line.startsWith("#") ? line.slice(1) : "")),
    blankBefore: start > 0,
    blankAfter: lines.length - end > 1,
  };
}

function restorePair(map: YAMLMap, index: number, text: string): void {
  const { value } = map.items[index];
  const next = map.items[index + 1];
  if (!isScalar(value) || value.value !== null || value.comment === undefined)
    return;
  const nextKey = isScalar(next?.key) ? next.key : undefined;
  const [, valueEnd, nodeEnd] = value.range ?? [];
  if (valueEnd === undefined || nodeEnd === undefined) return;
  const end = nextKey?.range?.[0] ?? nodeEnd;
  const block = commentBlock(text.slice(valueEnd, end));
  if (!block.below.length) return;
  value.comment = block.inline;
  const moved = block.below.join("\n");
  if (nextKey === undefined) {
    const trailing = block.blankAfter ? `${moved}\n` : moved;
    map.comment =
      map.comment === undefined ? trailing : `${trailing}\n${map.comment}`;
    return;
  }
  nextKey.commentBefore = moved;
  nextKey.spaceBefore = block.blankBefore || undefined;
}

/**
 * The `yaml` parser hands the first comment line under a key with an empty value, such as `workflow_dispatch:`, to that
 * value as its trailing comment, so a rewrite prints it on the key's line and splits the comment block with a blank
 * line. This reads those lines back from `text`, the source `document` was parsed from, and gives them to the next
 * key, or to the map's trailing comment when the key is the map's last.
 */
export function restoreEmptyValueComments(
  document: Document,
  text: string,
): void {
  visit(document, {
    Map(_key, map) {
      for (const index of map.items.keys()) restorePair(map, index, text);
    },
  });
}
