import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const JAR = join("antelopejs-formal", "tla2tools-1.7.4.jar");

/** A fresh `XDG_CACHE_HOME` with no result cached, holding a copy of the TLC jar from the test run's own cache when it has one, so it downloads nothing. */
export function scratchCache(): string {
  const cache = mkdtempSync(join(tmpdir(), "formal-cache-"));
  const jar = join(
    process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
    JAR,
  );
  mkdirSync(join(cache, "antelopejs-formal"));
  if (existsSync(jar)) copyFileSync(jar, join(cache, JAR));
  return cache;
}

/** The result files a cache folder holds. */
export function resultEntries(cache: string): string[] {
  const results = join(cache, "antelopejs-formal", "results");
  return readdirSync(results).map((name) => join(results, name));
}
