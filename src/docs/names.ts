/** A proper noun or acronym the documentation spells one way, with the wrong spellings the `Names` check rewrites to it. */
interface DocName {
  name: string;
  misspellings?: readonly string[];
}

/**
 * The one list of names the documentation standard knows. The `Names` check
 * derives its substitutions from the misspellings, and the sentence-case
 * heading rule (unslop rule 17) derives its exceptions from every name, so a
 * name added here is accepted capitalized inside a heading and spelled one way
 * everywhere.
 */
export const DOC_NAMES: readonly DocName[] = [
  {
    name: "AntelopeJS",
    misspellings: [
      "Antelope JS",
      "Antelope\\.js",
      "antelopejs",
      "Antelopejs",
      "antelopeJS",
    ],
  },
  { name: "AdonisJS" },
  { name: "AI" },
  { name: "Claude Code" },
  { name: "Claude" },
  { name: "ChatGPT" },
  { name: "Codex" },
  { name: "DMS", misspellings: ["Dms", "dms"] },
  { name: "API" },
  { name: "AQL" },
  { name: "CLI" },
  { name: "CI" },
  { name: "CORS" },
  { name: "HA" },
  { name: "HTTP" },
  { name: "HTTPS" },
  { name: "IP" },
  { name: "JSON" },
  { name: "YAML" },
  { name: "SQL" },
  { name: "TLS" },
  { name: "URL" },
  { name: "PR" },
  { name: "PITR" },
  { name: "3DS" },
  { name: "DEBUG" },
  { name: "TRACE" },
  { name: "README" },
  { name: "Markdown" },
  { name: "TypeScript" },
  { name: "JavaScript" },
  { name: "Node.js" },
  { name: "MongoDB" },
  { name: "PostgreSQL" },
  { name: "RethinkDB" },
  { name: "Redis" },
  { name: "GitHub" },
  { name: "Docker" },
  { name: "Vue" },
  { name: "Nuxt" },
  { name: "Inertia" },
  { name: "Vale" },
  { name: "Playwright" },
  { name: "ESLint" },
  { name: "OpenTelemetry" },
  { name: "WebSocket" },
  { name: "Zod" },
  { name: "Stripe" },
  { name: "Mollie" },
  { name: "Cloud" },
  { name: "Diátaxis" },
  { name: "OAuth" },
  { name: "JWT" },
  { name: "MDC" },
  { name: "TLA+" },
  { name: "npm" },
  { name: "pnpm" },
];
