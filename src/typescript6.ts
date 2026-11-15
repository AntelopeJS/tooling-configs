import ts from "typescript";

import { requireTypeScript6 } from "./typescript-version.ts";

requireTypeScript6(ts.version);

/** The pack's own TypeScript 6, checked on load: every module that uses the compiler API at runtime imports it from here. */
export default ts;
