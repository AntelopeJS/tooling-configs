import { RuleTester } from "oxlint/plugins-dev";

import { noUnknownParametersRule } from "./no-unknown-parameters.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "unknownParameter" };

/** cloud@c25f197 src/infra-provider/audit-chain.ts:72 `canonicalValue`. */
const CANONICAL_VALUE = `import { isBoolean, isNumber, isObject, isString } from "../guards";
import { toText } from "../text";
function canonicalValue(value: unknown): CanonicalValue {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isObject(value)) {
    return Object.entries(value)
      .sort(([left], [right]) => compareKeys(left, right))
      .reduce<CanonicalObject>((result, [key, nested]) => {
        result[key] = canonicalValue(nested);
        return result;
      }, {});
  }
  if (isBoolean(value) || isNumber(value) || isString(value)) return value;
  return toText(value);
}`;

/** antelopejs@main src/core/output/logging-utils.ts:237 `serializeLogValue`. */
const SERIALIZE_LOG_VALUE = `import { inspect } from "node:util";
import { isBoolean, isFunction, isNumber, isString, isSymbol } from "./guards";
export function serializeLogValue(value: unknown, ancestors = new Set<Error>()): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (isString(value)) return value;
  if (isNumber(value) || isBoolean(value)) return String(value);
  if (value instanceof Error) {
    return ancestors.has(value) ? CIRCULAR_ERROR : serializeError(value, ancestors);
  }
  if (value instanceof Date) return value.toISOString();
  if (isSymbol(value) || isFunction(value)) return inspect(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return inspect(value);
  }
}`;

/** cloud@c25f197 src/infra/app-values/validate.ts:47 `appValuesViolations`. */
const APP_VALUES_VIOLATIONS = `import Ajv, { type ValidateFunction } from "ajv";
function compileValidator(): ValidateFunction {
  return new Ajv({ allErrors: true }).compile(schema);
}
let validator: ValidateFunction | null = null;
export function appValuesViolations(values: unknown): readonly AppValuesViolation[] {
  validator ??= compileValidator();
  if (validator(values)) return [];
  return (validator.errors ?? []).map(readViolation);
}`;

/** dms-frontend@main src/project-modules.ts:416 `registrationOf`. */
const REGISTRATION_OF = `function registrationOf(id: string, folder: string, config: unknown, context: FrontendModuleContext): FrontendRegistration | undefined {
  const declaration = readLayerPackage(folder)?.[FRONTEND_DECLARATION_FIELD];
  if (!isText(declaration)) return undefined;
  // SAFETY: test fixture.
  const { frontendModule } = require(join(folder, declaration)) as { frontendModule?: FrontendModuleFunction };
  if (!isCallable(frontendModule)) throw new Error(id);
  return frontendModule(config, context);
}`;

const GUARDS = 'import { isString } from "./guards";\nimport { describe } from "./describe";\n';

tester.run("anti-slop/no-unknown-parameters at a parameter read through guards and forwarded", noUnknownParametersRule, {
	valid: [
		{
			name: "cloud canonicalValue: fails one that accepts guarded reads or forwards but not both in one function",
			code: CANONICAL_VALUE,
		},
		{
			name: "antelopejs serializeLogValue: fails one that refuses a forward inside a catch beside guarded reads",
			code: SERIALIZE_LOG_VALUE,
		},
		{
			name: "cloud appValuesViolations: fails one that trusts only imported or declared callees, or refuses a callee that starts null",
			code: APP_VALUES_VIOLATIONS,
		},
		{
			name: "dms-frontend registrationOf: fails one that refuses a callee destructured from a call's result under as",
			code: REGISTRATION_OF,
		},
		{
			name: "a callee a const holds from an imported factory: fails one that accepts only a lazily assigned callee",
			code: 'import { build } from "./check";\nconst check = build();\nfunction run(value: unknown): Report { return check(value); }',
		},
	],
	invalid: [
		{
			name: "a guarded read beside a forward to an undeclared global: fails one that counts any call argument as a forward",
			code: `${GUARDS}function label(value: unknown): string { if (isString(value)) return value; return sink(value); }`,
			errors: [error],
		},
		{
			name: "a guard and a forward beside an untested property read: fails one that stops judging once a forward is seen",
			code: `${GUARDS}function label(value: unknown): string { if (isString(value)) return value; describe(value); return value.name; }`,
			errors: [error],
		},
		{
			name: "a guard and a forward answering yes or no: fails one that drops the return type check for a mix",
			code: `${GUARDS}function known(value: unknown): boolean { if (isString(value)) return true; return describe(value); }`,
			errors: [error],
		},
		{
			name: "a forward beside JSON.stringify with no type test: fails one that counts a text conversion as the test a mix needs",
			code: `${GUARDS}function label(value: unknown): string { describe(value); return JSON.stringify(value); }`,
			errors: [error],
		},
		{
			name: "a callee later reassigned a function literal: fails one that judges only the initializer",
			code: 'import { build } from "./check";\nlet check = build();\ncheck = (input: any) => input.name;\nfunction run(value: unknown): Report { return check(value); }',
			errors: [error],
		},
		{
			name: "a callee aliasing another function: fails one that accepts any value that is not a literal",
			code: 'import { build } from "./check";\nlet check = build();\ncheck = handler;\nfunction run(value: unknown): Report { return check(value); }',
			errors: [error],
		},
		{
			name: "a callee an iterated call's element binds: fails one that trusts a for...of head as a call's result",
			code: 'import { checks } from "./check";\nfunction run(value: unknown): Report[] { const out: Report[] = []; for (const check of checks()) out.push(check(value)); return out; }',
			errors: [error],
		},
		{
			name: "a callee later assigned a local named undefined: fails one that matches undefined by name",
			code: 'import { build } from "./check";\nconst undefined = (input: any) => input.name;\nlet check = build();\ncheck = undefined;\nfunction run(value: unknown): Report { return check(value); }',
			errors: [error],
		},
		{
			name: "a callee only ever null: fails one that accepts a variable with no call written to it",
			code: "let check = null;\nfunction run(value: unknown): Report { return check(value); }",
			errors: [error],
		},
		{
			name: "a callee built by a function another parameter hands in: fails one that skips the parameter-root check",
			code: "function run(make: () => Check, value: unknown): Report { const check = make(); return check(value); }",
			errors: [{ ...error, data: { parameter: "value" } }],
		},
		{
			name: "a callee handed in as another parameter: fails one that trusts any identifier callee that is not a literal",
			code: "function run(check: Check, value: unknown): Report { return check(value); }",
			errors: [{ ...error, data: { parameter: "value" } }],
		},
		{
			name: "a forward to a built callee beside a property read: fails one that accepts the parameter once one read is a forward",
			code: 'import { build } from "./check";\nconst check = build();\nfunction run(value: unknown): Report { check(value); return value.report; }',
			errors: [error],
		},
	],
});
