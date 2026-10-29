import { existsSync, readFileSync } from "node:fs";

import {
  isObject,
  isString,
  parseJson,
  type JsonObject,
  type JsonValue,
} from "../garden/json.ts";
import type { DoorKind } from "./types.ts";

/** One row of the One-way doors section. */
interface DoorRow {
  kind: DoorKind;
  location: string;
  irreversible: string;
  containment: string;
  containmentJourney: string;
}

/** A file the door path rules flag that the verifier judged is not a door, with why. */
interface FalsePositive {
  kind: DoorKind;
  location: string;
  reason: string;
}

/** One linked docs page and whether it still matches the behaviour. */
interface DocsJudgement {
  page: string;
  matches: boolean;
  note: string;
}

/** What only the verifier can judge, written to evidence/judgement.json. */
export interface Judgement {
  notVerified: string[];
  attention: string[];
  docs: DocsJudgement[];
  doorsNone: string | null;
  doors: DoorRow[];
  falsePositives: FalsePositive[];
  verifier: string;
}

const DOOR_KINDS: readonly DoorKind[] = [
  "data",
  "format",
  "contract",
  "outbound",
  "exposure",
  "publish",
];

function isDoorKind(value: string): value is DoorKind {
  return DOOR_KINDS.some((kind) => kind === value);
}

function text(source: JsonObject, key: string): string {
  const value = source[key];
  return value !== undefined && isString(value) ? value.trim() : "";
}

function texts(source: JsonObject, key: string): string[] {
  const value = source[key];
  return Array.isArray(value) ? value.filter(isString) : [];
}

function objects(value: JsonValue | undefined): JsonObject[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function doorKind(value: string, label: string): DoorKind {
  if (!isDoorKind(value))
    throw new Error(
      `judgement.json: ${label} is "${value}", not one of ${DOOR_KINDS.join(", ")}`,
    );
  return value;
}

function parseRows(doors: JsonObject): DoorRow[] {
  return objects(doors.rows).map((row, index) => {
    const parsed = {
      location: text(row, "location"),
      irreversible: text(row, "irreversible"),
      containment: text(row, "containment"),
    };
    if (!parsed.location || !parsed.irreversible || !parsed.containment)
      throw new Error(
        `judgement.json: doors.rows[${index}] needs kind, location, irreversible and containment`,
      );
    return {
      ...parsed,
      kind: doorKind(text(row, "kind"), `doors.rows[${index}].kind`),
      containmentJourney: text(row, "containmentJourney"),
    };
  });
}

function parseFalsePositives(doors: JsonObject): FalsePositive[] {
  return objects(doors.falsePositives).map((entry, index) => {
    const location = text(entry, "location");
    const reason = text(entry, "reason");
    if (!location || !reason)
      throw new Error(
        `judgement.json: doors.falsePositives[${index}] needs location and reason`,
      );
    return {
      kind: doorKind(
        text(entry, "kind"),
        `doors.falsePositives[${index}].kind`,
      ),
      location,
      reason,
    };
  });
}

/** Parses evidence/judgement.json. A verdict without a One-way doors section is void, so a missing one throws. */
export function readJudgement(file: string): Judgement {
  if (!existsSync(file))
    throw new Error(
      `${file} is missing: write the verifier's judgement before rendering the verdict`,
    );
  const raw = parseJson(readFileSync(file, "utf8"));
  if (!isObject(raw)) throw new Error(`${file} must hold a JSON object`);
  const doors = raw.doors !== undefined && isObject(raw.doors) ? raw.doors : {};
  const rows = parseRows(doors);
  const none = text(doors, "none") || null;
  if (!none && rows.length === 0)
    throw new Error(
      "judgement.json: doors needs `none` with a reason or at least one row; a verdict without it is void",
    );
  const verifier = text(raw, "verifier");
  if (!verifier)
    throw new Error(
      "judgement.json: verifier must say who judged this run, for example the verifier thread's URL",
    );
  return {
    notVerified: texts(raw, "notVerified"),
    attention: texts(raw, "attention"),
    docs: objects(raw.docs).map((entry) => ({
      page: text(entry, "page"),
      matches: entry.matches === true,
      note: text(entry, "note"),
    })),
    doorsNone: none,
    doors: rows,
    falsePositives: parseFalsePositives(doors),
    verifier,
  };
}
