import assert from "node:assert/strict";
import test from "node:test";

import { put, read, testRepo } from "./helpers/test-repo.ts";
import { RELEASE_PATH } from "./release-workflow.ts";
import { syncRepository } from "./sync.ts";

/** AntelopeJS/.github scripts/release-train/frozen-caller.yml, which its release train tests dispatch. */
const FROZEN_CALLER = `name: Release

on:
  pull_request:
    types: [labeled, synchronize, reopened]
  workflow_dispatch:
    inputs:
      release-version:
        description: Stable version to release, set by the release train
        required: false
        type: string
      release-commit:
        description: Commit SHA to release, set by the release train
        required: false
        type: string
      dependency-ranges:
        description: JSON object of stable ranges that replace preview pins, set by the release train
        required: false
        default: "{}"
        type: string
      preview:
        description: Publish a preview under the npm dist-tag next from the default branch or a work/* branch
        required: false
        default: false
        type: boolean

permissions:
  contents: write
  id-token: write

jobs:
  release:
    uses: AntelopeJS/.github/.github/workflows/release-npm-public.yml@v2
    with:
      release-version: \${{ inputs.release-version }}
      release-commit: \${{ inputs.release-commit }}
      dependency-ranges: \${{ inputs.dependency-ranges }}
      preview: \${{ inputs.preview == true }}
    secrets:
      RELEASE_APP_ID: \${{ secrets.RELEASE_APP_ID }}
      RELEASE_APP_PRIVATE_KEY: \${{ secrets.RELEASE_APP_PRIVATE_KEY }}
`;

/** The caller sync wrote before AntelopeJS/.github v2 moved previews to a dispatch: a push trigger and no preview input. */
const PUSH_CALLER = `name: Release

on:
  push:
    branches: [main]
  pull_request:
    types: [labeled, synchronize, reopened]
  workflow_dispatch:
    inputs:
      release-version:
        description: Stable version to release, set by the release train
        required: false
        type: string
      release-commit:
        description: Commit SHA to release, set by the release train
        required: false
        type: string
      dependency-ranges:
        description: JSON object of stable ranges that replace preview pins, set by the release train
        required: false
        default: "{}"
        type: string

permissions:
  contents: write
  id-token: write

jobs:
  release:
    uses: AntelopeJS/.github/.github/workflows/release-npm-public.yml@v2
    with:
      release-version: \${{ inputs.release-version }}
      release-commit: \${{ inputs.release-commit }}
      dependency-ranges: \${{ inputs.dependency-ranges }}
    secrets:
      RELEASE_APP_ID: \${{ secrets.RELEASE_APP_ID }}
      RELEASE_APP_PRIVATE_KEY: \${{ secrets.RELEASE_APP_PRIVATE_KEY }}
`;

function repoWith(t: test.TestContext, caller: string): string {
  const root = testRepo(t);
  put(
    root,
    "package.json",
    JSON.stringify({ name: "@antelopejs/mongodb", type: "module" }),
  );
  put(root, RELEASE_PATH, caller);
  return root;
}

test("a public root package gets AntelopeJS/.github's frozen caller byte for byte, which --check accepts, and the push-triggered caller without a preview input is drift that sync rewrites, so a sync that keeps the push trigger or drops preview fails", (t) => {
  const frozen = repoWith(t, FROZEN_CALLER);
  assert.equal(
    syncRepository(frozen, { check: true }).paths.includes(RELEASE_PATH),
    false,
  );
  const pushed = repoWith(t, PUSH_CALLER);
  assert.equal(
    syncRepository(pushed, { check: true }).paths.includes(RELEASE_PATH),
    true,
  );
  syncRepository(pushed);
  assert.equal(read(pushed, RELEASE_PATH), FROZEN_CALLER);
});
