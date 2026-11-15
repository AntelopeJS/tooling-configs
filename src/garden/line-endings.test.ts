import assert from "node:assert/strict";
import test from "node:test";

import { lineEndings } from "./checks/line-endings.ts";
import { FakeApi } from "./helpers/fake-api.ts";
import { isStackRepo } from "./stack.ts";
import type { CheckResult } from "./types.ts";

function keys(result: CheckResult): string[] {
  assert.equal(result.kind, "findings");
  return result.kind === "findings"
    ? result.findings.map(({ key }) => key)
    : [];
}

test("the stack is the framework, its interfaces, modules, file storages and templates, and DMS, but not dms-builder, cloud, the site, infra or agent repositories", () => {
  const stack = [
    "antelopejs",
    "tooling-configs",
    "interface-core",
    "api",
    "rethinkdb",
    "mysql",
    "file-storage-s3",
    "template-dms",
    "dms",
    "dms-frontend",
  ];
  const outside = [
    "dms-builder",
    "cloud",
    "cloud-sdk",
    "cloud-pricing-app",
    "antelope-web",
    "k8s-gitops-infra",
    "video-kit",
    "agent-skills",
    "interfaces",
    ".github",
  ];
  assert.deepEqual(
    stack.filter((name) => !isStackRepo(name)),
    [],
  );
  assert.deepEqual(outside.filter(isStackRepo), []);
});

test("line-endings reports each stack repository whose .gitattributes is missing or lacks the LF line, and skips repositories outside the stack", async () => {
  const api = new FakeApi()
    .org([
      { name: "interface-core" },
      { name: "mongodb" },
      { name: "template-dms", pack: "template" },
      { name: "cloud" },
    ])
    .repo("interface-core", {
      ".gitattributes": "*.png binary\n* text=auto eol=lf\n",
    })
    .repo("mongodb", { ".gitattributes": "* text=auto\n" })
    .repo("template-dms", { "README.md": "Template.\n" })
    .repo("cloud", { "README.md": "Cloud.\n" });
  assert.deepEqual(keys(await lineEndings.run(api.context())), [
    "mongodb|line-endings|gitattributes",
    "template-dms|line-endings|gitattributes",
  ]);
});
