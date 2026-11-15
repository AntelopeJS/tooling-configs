#!/usr/bin/env node
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const manifest = fileURLToPath(import.meta.resolve("typescript7/package.json"));
await import(pathToFileURL(join(dirname(manifest), "bin", "tsc")).href);
