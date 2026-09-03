import { antelopeFmtPreset } from "./src/oxc/fmt.ts";

export default antelopeFmtPreset({
  // Upstream's source, kept byte-identical so it can be diffed against new releases.
  ignorePatterns: ["src/oxc/anti-slop/**", "dist/**", "node_modules/**"],
});
