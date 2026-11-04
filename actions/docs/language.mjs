/** Words that mark a paragraph as English. */
const ENGLISH = new Set(
  "the of and to a in is that for it with as are this be on by or an from can not you your if at which will has have was were but when then each also into its they their there than so such any all".split(
    " ",
  ),
);

/** Function words of other Latin-script languages. A word English also uses is left out, so one English sentence never scores as foreign. */
const FOREIGN = Object.values({
  fr: "le la les des du de un une et est sont pour dans que qui sur avec pas ce cette il elle vous nous au aux ou par plus mais ne se sa ses leur leurs nos votre vos ont fait être",
  es: "el los las del de un una y es son para en que con por no se su al lo como más pero sus este esta ese esa muy está hay usted cuando donde",
  de: "der die das den dem des und ist sind für mit von zu nicht ein eine einen auf im auch wie aber oder wenn werden wird dass sich nur kann sie wir ihr",
  it: "il lo gli le di del della dei delle un uno una e è sono per con che non si su come più ma questo questa quando dove anche sia nel nella",
  pt: "o os as do da dos das um uma e é são para com que não em se por mais mas seu sua este esta como quando onde também está você",
}).map((list) => new Set(list.split(" ").filter((word) => !ENGLISH.has(word))));

const MINIMUM_WORDS = 5;
/** Distinct foreign function words a paragraph needs before it counts as foreign. */
const MINIMUM_FOREIGN_WORDS = 3;
const MINIMUM_LETTERS = 8;

/** Letters of a script other than Latin: Cyrillic, Greek, Arabic, Hebrew, Indic, Thai, Hangul, Kana and CJK. */
const OTHER_SCRIPT =
  /[\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Devanagari}\p{Script=Thai}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/gu;

/** Blanks fenced code, line by line, keeping every newline. */
function withoutFences(text) {
  let fence;
  return text
    .split("\n")
    .map((line) => {
      const marker = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
      if (fence === undefined && marker) {
        fence = marker;
        return "";
      }
      if (fence !== undefined) {
        if (marker && marker[0] === fence[0] && marker.length >= fence.length)
          fence = undefined;
        return "";
      }
      return line;
    })
    .join("\n");
}

/** Replaces what is not prose with spaces of the same length, newlines kept, so line numbers survive. */
function blank(text) {
  const spaces = (match) => match.replace(/[^\n]/g, " ");
  return withoutFences(text)
    .replace(/<!--[\s\S]*?-->/g, spaces)
    .replace(/`[^`\n]*`/g, spaces)
    .replace(/<[^>\n]+>/g, spaces)
    .replace(/\]\([^)\n]*\)/g, spaces)
    .replace(/\bhttps?:\/\/\S+/g, spaces);
}

function letterWords(paragraph) {
  return paragraph.toLowerCase().match(/\p{L}[\p{L}'’]*/gu) ?? [];
}

function isOtherScript(paragraph) {
  const letters = paragraph.match(/\p{L}/gu)?.length ?? 0;
  const other = paragraph.match(OTHER_SCRIPT)?.length ?? 0;
  return letters >= MINIMUM_LETTERS && other / letters >= 0.5;
}

function isForeignLatin(words) {
  const english = words.filter((word) => ENGLISH.has(word)).length;
  return FOREIGN.some((set) => {
    const hits = words.filter((word) => set.has(word));
    return new Set(hits).size >= MINIMUM_FOREIGN_WORDS && hits.length > english;
  });
}

/**
 * Finds the paragraphs of Markdown prose that are not English, by function words and script.
 * Fences, inline code, comments, HTML tags and URLs are skipped, and so is any paragraph of fewer than five words.
 * It is a heuristic for whole paragraphs, not a language detector: a sentence in another language inside an English paragraph passes.
 * @param {string} markdown
 * @returns {{ line: number }[]} the 1-based line where each foreign paragraph starts
 */
export function foreignProse(markdown) {
  const found = [];
  let line = 1;
  for (const block of blank(markdown).split(/(\n[ \t]*\n)/)) {
    const lead = block.match(/^\s*/)[0];
    const words = letterWords(block);
    if (
      isOtherScript(block) ||
      (words.length >= MINIMUM_WORDS && isForeignLatin(words))
    )
      found.push({ line: line + (lead.match(/\n/g)?.length ?? 0) });
    line += block.match(/\n/g)?.length ?? 0;
  }
  return found;
}
