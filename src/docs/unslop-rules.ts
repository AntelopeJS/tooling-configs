/** The sections of the unslop skill, in the order they appear. */
export const UNSLOP_GROUPS = [
  "Content",
  "Language",
  "Style",
  "Communication artifacts",
  "Filler",
  "Jargon",
  "Plain speech",
] as const;

/** A section of the unslop skill. */
type UnslopGroup = (typeof UNSLOP_GROUPS)[number];

/** How a rule is checked mechanically, when a machine can check it. */
export type UnslopCheck =
  | {
      kind: "existence";
      message: string;
      tokens: string[];
      ignorecase?: boolean;
      nonword?: boolean;
    }
  | {
      kind: "substitution";
      message: string;
      swap: Record<string, string>;
      ignorecase?: boolean;
    }
  | { kind: "capitalization"; message: string; exceptions: string[] };

/** One numbered unslop rule: the id other skills cite, its section, the skill's own wording, and the check that enforces it when there is one. */
export interface UnslopRule {
  id: number;
  group: UnslopGroup;
  text: string;
  check?: UnslopCheck;
}

/** Checks that belong to the AntelopeJS documentation standard rather than to a numbered unslop rule, by Vale rule name. */
export const HOUSE_CHECKS: readonly { name: string; check: UnslopCheck }[] = [
  {
    name: "Names",
    check: {
      kind: "substitution",
      message: "Write '%s' instead of '%s'.",
      swap: {
        "Antelope JS": "AntelopeJS",
        "Antelope\\.js": "AntelopeJS",
        antelopejs: "AntelopeJS",
        Antelopejs: "AntelopeJS",
        antelopeJS: "AntelopeJS",
        Dms: "DMS",
        dms: "DMS",
      },
    },
  },
  {
    name: "Procedure",
    check: {
      kind: "existence",
      message: "Cut '%s'. It has no place in a procedure.",
      ignorecase: true,
      tokens: ["simply", "easy", "easily", "quickly", "please"],
    },
  },
];

/** The numbered rules of the unslop skill. The skill's rule section and the Vale style are generated from this table. */
export const UNSLOP_RULES: readonly UnslopRule[] = [
  {
    id: 3,
    group: "Content",
    text: '**Superficial -ing phrases.** "highlighting...", "ensuring...", "reflecting...", "showcasing...", "fostering...". Delete or expand with real sources.',
  },
  {
    id: 5,
    group: "Content",
    text: '**Vague attributions.** "Experts believe", "Industry reports suggest", "Some critics argue". Name the source or delete.',
  },
  {
    id: 7,
    group: "Language",
    text: "**AI vocabulary.** Additionally, crucial, delve, enduring, enhance, fostering, garner, interplay, intricate, landscape (abstract), pivotal, showcase, tapestry (abstract), testament, underscore, vibrant. Replace with plain words.",
    check: {
      kind: "existence",
      message:
        "Replace the AI vocabulary word '%s' with a plain word (unslop rule 7).",
      ignorecase: true,
      tokens: [
        "additionally",
        "crucial",
        "delve",
        "delves",
        "enduring",
        "enhance",
        "enhances",
        "enhanced",
        "enhancing",
        "fostering",
        "garner",
        "garners",
        "interplay",
        "intricate",
        "pivotal",
        "showcase",
        "showcases",
        "showcasing",
        "testament",
        "underscore",
        "underscores",
        "vibrant",
      ],
    },
  },
  {
    id: 8,
    group: "Language",
    text: '**Fancy ways to say "is".** "serves as", "stands as", "boasts", "features". Say "is" or "has".',
    check: {
      kind: "existence",
      message: "Say 'is' or 'has' instead of '%s' (unslop rule 8).",
      ignorecase: true,
      tokens: ["serves as", "stands as", "boasts"],
    },
  },
  {
    id: 9,
    group: "Language",
    text: '**"Not just X, but Y."** State the point directly instead.',
  },
  {
    id: 10,
    group: "Language",
    text: "**Rule of three.** Don't force ideas into groups of three. Use the natural number.",
  },
  {
    id: 11,
    group: "Language",
    text: "**Synonym cycling.** Protagonist, main character, central figure, hero all in one paragraph. Pick one, repeat it.",
  },
  {
    id: 12,
    group: "Language",
    text: '**False ranges.** "from X to Y" where X and Y aren\'t on a meaningful scale. List topics directly.',
  },
  {
    id: 13,
    group: "Style",
    text: "**Em dash overuse.** Avoid em dashes entirely. Use periods or commas only (no parentheses, no en dashes, no hyphen-as-dash substitutes). If a thought needs separation, end the sentence or use a comma.",
    check: {
      kind: "existence",
      message: "Use a period or a comma instead of a dash (unslop rule 13).",
      nonword: true,
      tokens: ["\u2014", "\u2013"],
    },
  },
  {
    id: 14,
    group: "Style",
    text: '**Colon overuse.** Colons are fine before a list or example, not as mid-sentence connectors. "If you\'re coming from traditional automation: instead of registering event handlers, you describe conditions" adds nothing with the colon. Rewrite to let the point stand on its own without comparison framing. "Describing when the scheduler should fire works best as plain English." Same meaning, no crutch punctuation.',
  },
  {
    id: 15,
    group: "Style",
    text: "**Boldface overuse.** Don't bold every proper noun or acronym.",
  },
  {
    id: 16,
    group: "Style",
    text: '**Inline-header lists.** The tell is a bold label and colon that restates the line: "**Performance:** Performance improved...". Convert those to prose. A bold lead-in that ends in a period, names the item, and is followed by genuinely new detail ("**Schema in TypeScript.** Tables live in one file.") is fine, not a tell.',
  },
  {
    id: 17,
    group: "Style",
    text: "**Title case headings.** Use sentence case.",
    check: {
      kind: "capitalization",
      message: "Use sentence case in headings (unslop rule 17).",
      exceptions: [
        "AntelopeJS",
        "DMS",
        "API",
        "CLI",
        "CI",
        "HTTP",
        "HTTPS",
        "JSON",
        "YAML",
        "SQL",
        "URL",
        "README",
        "Markdown",
        "TypeScript",
        "JavaScript",
        "Node.js",
        "MongoDB",
        "PostgreSQL",
        "RethinkDB",
        "Redis",
        "GitHub",
        "Docker",
        "Vue",
        "Nuxt",
        "Vale",
        "Playwright",
        "Diátaxis",
        "OAuth",
        "JWT",
        "MDC",
        "TLA+",
        "npm",
        "pnpm",
      ],
    },
  },
  {
    id: 18,
    group: "Style",
    text: "**Decorative emojis.** Remove from headings and bullets.",
    check: {
      kind: "existence",
      message: "Remove the decorative emoji (unslop rule 18).",
      nonword: true,
      tokens: ["[\\x{1F300}-\\x{1FAFF}]"],
    },
  },
  {
    id: 19,
    group: "Style",
    text: "**Curly quotes.** Use straight quotes.",
    check: {
      kind: "existence",
      message: "Use a straight quote (unslop rule 19).",
      nonword: true,
      tokens: ["[\u2018\u2019\u201C\u201D]"],
    },
  },
  {
    id: 20,
    group: "Communication artifacts",
    text: '**Chatbot phrases.** "I hope this helps!", "Let me know if...", "Of course!", "Certainly!", "Found the smoking gun!" Remove.',
    check: {
      kind: "existence",
      message: "Remove the chatbot phrase '%s' (unslop rule 20).",
      ignorecase: true,
      tokens: [
        "I hope this helps",
        "Let me know if",
        "Of course!",
        "Certainly!",
      ],
    },
  },
  {
    id: 22,
    group: "Communication artifacts",
    text: '**Sycophantic tone.** "Great question! You\'re absolutely right!" Respond directly.',
    check: {
      kind: "existence",
      message: "Answer directly instead of '%s' (unslop rule 22).",
      ignorecase: true,
      tokens: ["Great question", "You're absolutely right"],
    },
  },
  {
    id: 23,
    group: "Filler",
    text: '**Filler phrases.** "In order to" becomes "To". "Due to the fact that" becomes "Because". Delete "It is important to note that".',
    check: {
      kind: "existence",
      message: "Cut the filler phrase '%s' (unslop rule 23).",
      ignorecase: true,
      tokens: [
        "in order to",
        "due to the fact that",
        "it is important to note that",
      ],
    },
  },
  {
    id: 24,
    group: "Filler",
    text: '**Excessive hedging.** "could potentially possibly be argued that it might" becomes "may".',
  },
  {
    id: 25,
    group: "Filler",
    text: '**Generic conclusions.** "The future looks bright." State specific plans or facts.',
  },
  {
    id: 26,
    group: "Jargon",
    text: '**Abstract metaphor nouns.** Substrate (base), wedge, wedge in (add), vector (way, method), locus, vantage, nexus, primitive as a noun, harness as a metaphor, surface as in "API surface", bedrock, scaffolding as a metaphor, modality, paradigm, gold-plating (more than the job needs), ratchet as a metaphor (the mechanism\'s real name, or a limit that only tightens), evacuate for moving code (move out), endgame (the last phase), north star, flywheel. These read as technical but usually have a plainer concrete word. Pick the concrete word.',
    check: {
      kind: "existence",
      message: "Use the concrete word instead of '%s' (unslop rule 26).",
      ignorecase: true,
      tokens: [
        "substrate",
        "wedge",
        "nexus",
        "locus",
        "vantage",
        "bedrock",
        "north star",
        "flywheel",
        "endgame",
        "paradigm",
        "modality",
        "gold-plating",
      ],
    },
  },
  {
    id: 27,
    group: "Plain speech",
    text: '**Say what it does, not how it feels.** "the database stays close at hand", "SQL you can read", "types that follow your schema" name a feeling. The fix names the mechanism or a number: "`.toSQL()` returns the exact string sent to the database", "a column rename fails the build". Ask what the sentence tells the reader to do or know, then write that. If you can\'t restate it as a concrete instruction, fact, or number, cut it. One more check: if the sentence could appear unchanged in another project\'s docs, it says nothing about this one. Cut it.',
  },
  {
    id: 28,
    group: "Plain speech",
    text: "**Shorten or split dense sentences.** If the reader has to backtrack to parse a sentence, break it in two or drop clauses. One idea per sentence.",
  },
  {
    id: 29,
    group: "Plain speech",
    text: '**Active voice.** Prefer it. Catch "is/are/was/were + past participle" and name the actor: "queries are validated" becomes "the compiler validates queries", "the file is parsed by the loader" becomes "the loader parses the file". Passive is fine only when the actor is unknown or genuinely doesn\'t matter.',
  },
  {
    id: 30,
    group: "Plain speech",
    text: '**Cut adverbs, or use a stronger verb.** "runs quickly" becomes "is fast" or the number, and "significantly improves" becomes the measured delta. An adverb propping up a weak verb means the verb is wrong.',
  },
  {
    id: 31,
    group: "Plain speech",
    text: '**Prefer the plain word.** "utilize" and "leverage" become "use", "facilitate" becomes "help", "numerous" becomes "many", "in the event that" becomes "if". The fancier synonym is rarely clearer.',
    check: {
      kind: "substitution",
      message: "Use '%s' instead of '%s' (unslop rule 31).",
      ignorecase: true,
      swap: {
        utilize: "use",
        utilizes: "uses",
        utilizing: "using",
        leverage: "use",
        leverages: "uses",
        leveraging: "using",
        facilitate: "help",
        numerous: "many",
        "in the event that": "if",
      },
    },
  },
  {
    id: 32,
    group: "Plain speech",
    text: '**Mannered prose.** Metaphor or flourish where a literal phrase exists: aphorisms ("wire it or delete it"), rhetorical fragments for effect, personified code ("the plan holds it"), figurative verbs ("rides along", "stands on"), stock framing phrases. "A dial worth turning" becomes "a parameter worth varying". Say what you mean. Rule 26 covers the metaphor nouns.',
  },
  {
    id: 33,
    group: "Plain speech",
    text: '**Over-compression.** Dropped articles, verbless fragments, symbol-speak, and abbreviations that make the reader decode instead of read. "Parser rejects bad date → exit 2, no write" becomes "The parser rejects a bad date, exits with code 2, and writes nothing." Write whole sentences with their articles and verbs, and spell out arrows and abbreviations.',
  },
];
