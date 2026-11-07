import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { put } from "../../guardrails/helpers/test-repo.ts";

/**
 * A command that installs a fake registry module into a project's
 * `.antelope/cache` the way `ajs` does: it reuses a module the manifest holds
 * unless the project's lock record differs from the module's lockfile, and
 * otherwise writes the module's files, the record's lockfile or a freshly
 * resolved one, then its version in `manifest.json`, then a lock record when
 * the project had none. Mode `fresh` installs again, as `ignoreCache` does.
 * Mode `fake` rebuilds the module with `value.txt` set to `FAKE` and writes
 * the manifest again, in one command, as no `ajs` install does.
 */
function packageInstaller(log: string): string {
  return `import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const [project, name, mode] = process.argv.slice(2);
const cache = join(project, ".antelope/cache");
const file = join(cache, "manifest.json");
const manifest = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
const module = join(cache, name);
const lockfile = join(module, "pnpm-lock.yaml");
const record = join(project, "antelope-lock", name + "@1.0.0", "pnpm-lock.yaml");
const pinned = existsSync(record) ? readFileSync(record, "utf8") : undefined;
const reusable = manifest[name] !== undefined && (pinned === undefined || (existsSync(lockfile) && readFileSync(lockfile, "utf8") === pinned));
if (mode === "fresh" || mode === "fake" || !reusable) {
  if (mode !== "fake") appendFileSync(${JSON.stringify(log)}, name + "\\n");
  rmSync(module, { recursive: true, force: true });
  mkdirSync(join(module, "node_modules"), { recursive: true });
  for (let index = 0; index < 400; index += 1) writeFileSync(join(module, "file-" + index + ".js"), "module.exports = " + index + ";\\n");
  writeFileSync(join(module, "value.txt"), mode === "fake" ? "FAKE\\n" : "installed\\n");
  writeFileSync(lockfile, pinned ?? "fresh\\n");
  symlinkSync("../value.txt", join(module, "node_modules/link"));
  manifest[name] = "1.0.0";
  writeFileSync(file, JSON.stringify(manifest));
}
if (pinned === undefined) {
  mkdirSync(dirname(record), { recursive: true });
  writeFileSync(record, readFileSync(lockfile, "utf8"));
}
`;
}

/**
 * A command that installs a git module into a project's `.antelope/cache` the
 * way `ajs` does: it clones the remote when the manifest does not hold it, and
 * otherwise fetches and, when `origin/main` moved, resets to it. After a clone
 * or a move it runs the install command, which writes the command's text to
 * `dist/built.txt`, and records `git:main:<commit>` in the manifest.
 */
function gitInstaller(log: string): string {
  return `import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [project, remote, command] = process.argv.slice(2);
const cache = join(project, ".antelope/cache");
const file = join(cache, "manifest.json");
const manifest = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
const name = remote.replace(/[^a-zA-Z0-9_]/g, "_");
const module = join(cache, name);
const git = (...args) => execFileSync("git", args, { cwd: module, encoding: "utf8" }).trim();
let install = false;
if (manifest[name] === undefined || !existsSync(join(module, ".git"))) {
  rmSync(module, { recursive: true, force: true });
  mkdirSync(cache, { recursive: true });
  execFileSync("git", ["clone", "-q", remote, name], { cwd: cache });
  install = true;
} else {
  git("fetch", "-q");
  if ("git:main:" + git("rev-parse", "origin/main") !== manifest[name]) {
    git("reset", "-q", "--hard", "origin/main");
    install = true;
  }
}
if (install) {
  appendFileSync(${JSON.stringify(log)}, name + "\\n");
  mkdirSync(join(module, "dist"), { recursive: true });
  writeFileSync(join(module, "dist/built.txt"), command + "\\n");
  manifest[name] = "git:main:" + git("rev-parse", "HEAD");
  writeFileSync(file, JSON.stringify(manifest));
}
`;
}

/** Paths of a fake `ajs` in `tmp`: its installers, the log of each install, and a bare git remote with one commit on `main` beside a clone that pushes to it. */
export interface FakeAjs {
  packages: string;
  git: string;
  log: string;
  remote: string;
  clone: string;
}

/** Writes the fake `ajs` installers and a bare git remote under `tmp`. */
export function fakeAjs(tmp: string): FakeAjs {
  const log = join(tmp, "installs.log");
  const remote = join(tmp, "remote.git");
  const clone = join(tmp, "remote-clone");
  put(tmp, "install.mjs", packageInstaller(log));
  put(tmp, "install-git.mjs", gitInstaller(log));
  mkdirSync(clone);
  const git = (cwd: string, ...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", ...args],
      {
        cwd,
        stdio: "ignore",
      },
    );
  git(tmp, "init", "-q", "--bare", "-b", "main", remote);
  git(clone, "init", "-q", "-b", "main");
  put(clone, "index.js", "module.exports = 1;\n");
  git(clone, "add", ".");
  git(clone, "commit", "-q", "-m", "one");
  git(clone, "push", "-q", remote, "main");
  return {
    packages: join(tmp, "install.mjs"),
    git: join(tmp, "install-git.mjs"),
    log,
    remote,
    clone,
  };
}
