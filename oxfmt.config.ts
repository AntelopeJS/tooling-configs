import { antelopeFmtPreset } from "./src/oxc/fmt.ts";

/** `src/oxc/anti-slop/**` is upstream's source, kept byte-identical so it can be diffed against new releases. */
export default antelopeFmtPreset({
  ignorePatterns: ["src/oxc/anti-slop/**"],
});
