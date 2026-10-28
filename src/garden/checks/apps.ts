import type { GardenApi } from "../api.ts";
import type { Check } from "../check.ts";
import { ORG } from "../context.ts";
import { object, str } from "../json.ts";
import { finding, found, type Finding } from "../types.ts";

const ALTAB = "Altab-S-R-L";

/** The AI apps recorded on 2026-10-26: installed on all repositories, or pinned to selected ones. */
interface AppBaseline {
  all: string[];
  selectedOnly: string[];
}

const ORG_BASELINE: AppBaseline = {
  all: ["amp-for-github", "claude", "chatgpt-codex-connector"],
  selectedOnly: [],
};

const ALTAB_BASELINE: AppBaseline = {
  all: ["claude", "chatgpt-codex-connector"],
  selectedOnly: ["amp-for-github"],
};

interface Installation {
  slug: string;
  selection: string;
}

async function installations(
  api: GardenApi,
  org: string,
): Promise<Installation[]> {
  const pages = await api.pages(`/orgs/${org}/installations`, "installations");
  return pages.map((entry) => {
    const source = object(entry, "installation");
    return {
      slug: str(source, "app_slug"),
      selection: str(source, "repository_selection"),
    };
  });
}

function drift(org: string, apps: Installation[]): Finding[] {
  const baseline = org === ALTAB ? ALTAB_BASELINE : ORG_BASELINE;
  const findings: Finding[] = [];
  for (const app of apps) {
    if (/cursor/i.test(app.slug))
      findings.push(
        finding(
          { repo: org, check: "ai-apps", subject: `cursor:${app.slug}` },
          `Cursor's app ${app.slug} is installed on ${org}.`,
          `The app is uninstalled from ${org}.`,
        ),
      );
    const pinned = baseline.selectedOnly.includes(app.slug);
    if (app.selection === "all" && !pinned && !baseline.all.includes(app.slug))
      findings.push(
        finding(
          { repo: org, check: "ai-apps", subject: `app:${app.slug}` },
          `${app.slug} is installed on all repositories of ${org} and is not in the baseline.`,
          `${app.slug} is limited to selected repositories, or Antony adds it to the baseline.`,
        ),
      );
    if (app.selection === "all" && pinned)
      findings.push(
        finding(
          { repo: org, check: "ai-apps", subject: `selected:${app.slug}` },
          `${app.slug} is installed on all repositories of ${org}; the baseline limits it to selected ones.`,
          `${app.slug} is limited to selected repositories on ${org}.`,
        ),
      );
  }
  return findings;
}

export const aiApps: Check = {
  id: "ai-apps",
  async run(context) {
    const findings: Finding[] = [];
    for (const org of [ORG, ALTAB])
      findings.push(...drift(org, await installations(context.api, org)));
    return found(findings);
  },
};

export const orbSecrets: Check = {
  id: "orb-secrets",
  async run(context) {
    const surface = context.api.secrets();
    return found([
      ...surface.variables.map((name) =>
        finding(
          { repo: ORG, check: "orb-secrets", subject: `env:${name}` },
          `The environment variable ${name} is set in the scanning process.`,
          `${name} is removed from the scanner's environment.`,
        ),
      ),
      ...surface.files.map((file) =>
        finding(
          { repo: ORG, check: "orb-secrets", subject: `file:${file}` },
          `The credential file ~/${file} is readable by the scanning process.`,
          `~/${file} is removed from the scanner's machine.`,
        ),
      ),
    ]);
  },
};
