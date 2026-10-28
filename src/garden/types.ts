export type Severity = "normal" | "urgent";

export interface Finding {
  key: string;
  repo: string;
  check: string;
  subject: string;
  severity: Severity;
  evidence: string;
  doneMeans: string;
}

export interface Pause {
  repo: string;
  from: string;
  to: string;
  reason: string;
}

export interface Skipped {
  check: string;
  reason: string;
}

export interface Report {
  generatedAt: string;
  findings: Finding[];
  pauses: Pause[];
  skipped: Skipped[];
}

export type CheckResult =
  | { kind: "findings"; findings: Finding[] }
  | { kind: "skipped"; reason: string };

export interface FindingKey {
  repo: string;
  check: string;
  subject: string;
}

export function finding(
  id: FindingKey,
  evidence: string,
  doneMeans: string,
  severity: Severity = "normal",
): Finding {
  return {
    key: [id.repo, id.check, id.subject].join("|"),
    ...id,
    severity,
    evidence,
    doneMeans,
  };
}

export function found(findings: Finding[]): CheckResult {
  return { kind: "findings", findings };
}

export function skip(reason: string): CheckResult {
  return { kind: "skipped", reason };
}
