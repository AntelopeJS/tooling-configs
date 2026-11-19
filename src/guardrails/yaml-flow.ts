import {
  isMap,
  isPair,
  isScalar,
  isSeq,
  visit,
  type Document,
  type YAMLSeq,
} from "yaml";

const PRINT_WIDTH = 80;

function flatSequence(seq: YAMLSeq): string | undefined {
  const items: string[] = [];
  for (const item of seq.items) {
    if (!isScalar(item)) return undefined;
    items.push(String(item.source ?? item.value));
  }
  return `[${items.join(", ")}]`;
}

/**
 * oxfmt pads flow maps but not flow sequences and breaks a long flow sequence in a style YAML serializers cannot
 * produce, so a rewritten file is only left formatted by turning every non-empty flow map and every flow sequence that
 * would overflow the print width into block style.
 */
export function blockOverflowingFlow(document: Document): void {
  visit(document, {
    Map(_key, map) {
      if (map.flow && map.items.length) map.flow = false;
    },
    Seq(_key, seq, path) {
      if (!seq.flow) return;
      const flat = flatSequence(seq);
      const parent = path.at(-1);
      const owner = isPair(parent) && isScalar(parent.key) ? parent.key : null;
      const nesting = path.filter(
        (ancestor) => isMap(ancestor) || isSeq(ancestor),
      ).length;
      const lead = owner === null ? 2 : String(owner.value).length + 2;
      if (
        flat === undefined ||
        2 * Math.max(nesting - 1, 0) + lead + flat.length > PRINT_WIDTH
      )
        seq.flow = false;
    },
  });
}
