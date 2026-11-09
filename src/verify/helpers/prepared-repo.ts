import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

import { read } from "../../guardrails/helpers/test-repo.ts";
import { CHECKS, feature, PUBLISH_DOORS, verifyRepo } from "./verify-repo.ts";

const SKILL = ".agents/skills/verify-module";

/** Logs the build, writes `value.txt` with a relative `link` and an absolute `abs` to it, makes the links `links.json` lists with `<folder>` standing for its folder, hard-links `store.txt` as `shared.txt` while it exists, hard-links `value.txt` as `twin.txt` while the twin marker exists, writes a file into HOME, makes a FIFO while the fifo marker exists, and exits 1 while the fail marker exists. */
const BUILD = `const fs = require("fs");
const path = require("path");
const [folder, log, flags] = process.argv.slice(1);
fs.appendFileSync(log, "built\\n");
fs.writeFileSync(path.join(folder, "value.txt"), "built\\n");
fs.symlinkSync("value.txt", path.join(folder, "link"));
fs.symlinkSync(path.join(folder, "value.txt"), path.join(folder, "abs"));
const links = path.join(flags, "links.json");
for (const [name, to] of Object.entries(fs.existsSync(links) ? JSON.parse(fs.readFileSync(links, "utf8")) : {}))
  fs.symlinkSync(to.replace("<folder>", folder), path.join(folder, name));
if (fs.existsSync(path.join(flags, "store.txt")))
  fs.linkSync(path.join(flags, "store.txt"), path.join(folder, "shared.txt"));
if (fs.existsSync(path.join(flags, "twin")))
  fs.linkSync(path.join(folder, "value.txt"), path.join(folder, "twin.txt"));
fs.writeFileSync(path.join(process.env.HOME, "from-build"), "");
if (fs.existsSync(path.join(flags, "fifo")))
  require("child_process").execFileSync("mkfifo", [path.join(folder, "pipe")]);
process.exitCode = fs.existsSync(path.join(flags, "fail")) ? 1 : 0;`;

function config(log: string, flags: string): string {
  return `import { existsSync, readdirSync, readFileSync, readlinkSync, appendFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { equal, exitIs } from ${JSON.stringify(CHECKS)};
const prepare = (context) =>
  context.prepared("tree", async (folder) => {
    const made = await context.command("build", process.execPath, ["-e", ${JSON.stringify(BUILD)}, folder, ${JSON.stringify(log)}, ${JSON.stringify(flags)}]);
    if (!existsSync(join(${JSON.stringify(flags)}, "nocheck"))) context.expect(made.folder, [exitIs(made, 0)]);
  });
export default {
  doors: ${PUBLISH_DOORS},
  journeys: {
    reader: {
      title: "reads the prepared tree",
      entryPoint: "node",
      async run(context) {
        const folder = await prepare(context);
        const after = context.tree("prepared tree", folder);
        context.expect(after.folder, [
          equal("value.txt is as built", readFileSync(join(folder, "value.txt"), "utf8"), "built\\n"),
          equal("HOME is as it was", readdirSync(context.home), []),
        ]);
      },
    },
    writer: {
      title: "writes through the prepared link",
      entryPoint: "node",
      async run(context) {
        const folder = await prepare(context);
        appendFileSync(join(folder, "link"), "dirty\\n");
        const after = context.tree("written tree", folder);
        context.expect(after.folder, [equal("value.txt took the write", readFileSync(join(folder, "value.txt"), "utf8"), "built\\ndirty\\n")]);
      },
    },
    linker: {
      title: "writes through the absolute prepared link",
      entryPoint: "node",
      async run(context) {
        const folder = await prepare(context);
        appendFileSync(join(folder, "abs"), "linked\\n");
        const after = context.tree("linked tree", folder);
        context.expect(after.folder, [
          equal("abs points into this journey's folder", readlinkSync(join(folder, "abs")), join(folder, "value.txt")),
          equal("value.txt took the write", readFileSync(join(folder, "value.txt"), "utf8"), "built\\nlinked\\n"),
        ]);
      },
    },
    sharer: {
      title: "reads the prepared hard link",
      entryPoint: "node",
      async run(context) {
        const folder = await prepare(context);
        const shared = join(folder, "shared.txt");
        writeFileSync(join(${JSON.stringify(flags)}, "seen.json"), JSON.stringify({ ino: statSync(shared).ino, value: statSync(join(folder, "value.txt")).nlink }));
        const after = context.tree("shared tree", folder);
        context.expect(after.folder, [equal("shared.txt is as stored", readFileSync(shared, "utf8"), "stored\\n")]);
      },
    },
    editor: {
      title: "edits the prepared hard link",
      entryPoint: "node",
      async run(context) {
        const folder = await prepare(context);
        const edited = context.edit("edit shared", join(folder, "shared.txt"), "edited\\n");
        context.expect(edited, [equal("shared.txt took the edit", readFileSync(join(folder, "shared.txt"), "utf8"), "edited\\n")]);
      },
    },
    "failed-editor": {
      title: "edits the prepared hard link and records how it failed",
      entryPoint: "node",
      async run(context) {
        const folder = await prepare(context);
        const shared = join(folder, "shared.txt");
        const failure = (() => {
          try {
            context.edit("edit shared", shared, "edited\\n");
            return "none";
          } catch (error) {
            return error.code;
          }
        })();
        writeFileSync(join(${JSON.stringify(flags)}, "edit.json"), JSON.stringify({ failure, entries: readdirSync(folder).filter((name) => name.startsWith(".edit")) }));
        const after = context.tree("after the failed edit", folder);
        context.expect(after.folder, [equal("shared.txt is as stored", readFileSync(shared, "utf8"), "stored\\n")]);
      },
    },
    shape: {
      title: "holds the links the build made",
      entryPoint: "node",
      async run(context) {
        const folder = await prepare(context);
        const made = JSON.parse(readFileSync(join(${JSON.stringify(flags)}, "links.json"), "utf8"));
        const after = context.tree("shaped tree", folder);
        context.expect(after.folder, Object.entries(made).map(([name, to]) =>
          equal(\`\${name} points to \${to}\`, readlinkSync(join(folder, name)), to.replace("<folder>", folder))));
      },
    },
  },
};
`;
}

/** Wraps `readdirSync` so a copy of what the run kept, once it has listed the kept folder, finds it deleted or replaced by an identical copy. */
function memoHook(mode: "vanish" | "replace"): string {
  const meddle = {
    vanish: "fs.rmSync(memo, { recursive: true, force: true });",
    replace: `fs.renameSync(memo, memo + ".old");
fs.cpSync(memo + ".old", memo, { recursive: true, verbatimSymlinks: true });`,
  }[mode];
  return `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
const list = fs.readdirSync;
let done = false;
fs.readdirSync = (folder, options) => {
  const entries = list(folder, options);
  if (!done && String(folder).endsWith(join("prepared", "tree", "folder"))) {
    done = true;
    const memo = dirname(folder);
    ${meddle}
  }
  return entries;
};
syncBuiltinESMExports();
`;
}

/** Makes every write of `edited` create its file empty and then fail with ENOSPC, as on a full disk. */
const FULL_DISK = `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const write = fs.writeFileSync;
fs.writeFileSync = (file, content, options) => {
  if (content === "edited\\n") {
    write(file, "", options);
    throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
  }
  return write(file, content, options);
};
syncBuiltinESMExports();
`;

/** Makes `linkSync` fail with EMLINK, as on a filesystem whose link limit the file reached. */
const FULL_LINKS = `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
fs.linkSync = (from) => {
  throw Object.assign(new Error(\`EMLINK: too many links, link '\${from}'\`), { code: "EMLINK" });
};
syncBuiltinESMExports();
`;

/** A scratch repository whose journeys share the prepared key `tree`, with markers that shape its build and hooks that fault its copies. */
export function preparedRepo(t: TestContext) {
  const tmp = mkdtempSync(join(tmpdir(), "verify-prepared-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const log = join(tmp, "builds.log");
  const flags = join(tmp, "flags");
  mkdirSync(flags);
  const root = verifyRepo(t, {
    "README.md": "# Demo\n",
    "src/tree.ts": "export const tree = 1;\n",
    [`${SKILL}/verify.config.ts`]: config(log, flags),
    [`${SKILL}/features/smoke.md`]: feature([], ["reader"]),
    [`${SKILL}/features/tree.md`]: feature(["src/**"], ["writer", "reader"]),
    [`${SKILL}/features/links.md`]: feature([], ["linker"]),
    [`${SKILL}/features/shape.md`]: feature([], ["shape"]),
    [`${SKILL}/features/shared.md`]: feature([], ["sharer"]),
    [`${SKILL}/features/edits.md`]: feature([], ["editor"]),
    [`${SKILL}/features/full.md`]: feature([], ["failed-editor"]),
  });
  const builds = () =>
    existsSync(log) ? read(tmp, "builds.log").split("\n").length - 1 : 0;
  const flag = (name: string) => writeFileSync(join(flags, name), "");
  const unflag = (name: string) => rmSync(join(flags, name));
  const links = (made: Record<string, string>) =>
    writeFileSync(join(flags, "links.json"), JSON.stringify(made));
  const imported = (name: string, source: string) => {
    const file = join(tmp, `${name}.mjs`);
    writeFileSync(file, source);
    return { NODE_OPTIONS: `--import=${file}` };
  };
  const hook = (mode: "vanish" | "replace") => imported(mode, memoHook(mode));
  const store = (mode = 0o644) => {
    const file = join(flags, "store.txt");
    writeFileSync(file, "stored\n", { mode });
    return statSync(file).ino;
  };
  const seen = (): { ino: number; value: number } =>
    JSON.parse(read(flags, "seen.json"));
  const failedEdit = (): { failure: string; entries: string[] } =>
    JSON.parse(read(flags, "edit.json"));
  return {
    root,
    tmp,
    builds,
    flag,
    unflag,
    links,
    hook,
    store,
    seen,
    failedEdit,
    fullLinks: () => imported("full-links", FULL_LINKS),
    fullDisk: () => imported("full-disk", FULL_DISK),
  };
}
