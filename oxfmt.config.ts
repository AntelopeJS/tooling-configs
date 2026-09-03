import { antelopeFmtPreset } from "./src/oxc/fmt.ts";

export default antelopeFmtPreset({
  ignorePatterns: [
    // Upstream's source, kept byte-identical so it can be diffed against new releases.
    "src/oxc/anti-slop/**",
    // Written by changelogen on every release; reformatting it here would only
    // make the next release undo the change.
    "CHANGELOG.md",
  ],
});
