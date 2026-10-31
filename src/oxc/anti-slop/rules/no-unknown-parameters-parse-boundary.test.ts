import { RuleTester } from "oxlint/plugins-dev";

import { noUnknownParametersRule } from "./no-unknown-parameters.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "unknownParameter" };

tester.run("anti-slop/no-unknown-parameters at a parse boundary", noUnknownParametersRule, {
	valid: [
		{
			name: "dms-lang@a399cf8 src/validation/validate.ts:28 assertValidation with a schema",
			code: `export function validate<Output, Input>(
  schema: ZodType<Output, ZodTypeDef, Input>,
  input: unknown,
): Output {
  return assertValidation(
    input,
    (value) => schema.parse(value),
    (error) => (error instanceof ZodError ? refusal(error) : errorBody(INVALID_BODY)),
    errorStatus(INVALID_BODY),
  );
}`,
		},
		{
			name: "dms-media@df1cc55 src/validation/media.schema.ts:68 parseBody",
			code: `export function parseBody<Output>(
  body: unknown,
  schema: z.ZodType<Output, z.ZodTypeDef, unknown>,
): Output {
  return assertValidation(
    body,
    (value) => schema.parse(value),
    (error) => {
      const message = error instanceof ZodError ? error.issues[0]?.message : "";
      return message?.startsWith("$") ? message : MEDIA_ERRORS.invalidRequest;
    },
  );
}`,
		},
		{
			name: "postgres@887faab src/implementations/database/external-payload.ts:104 Decoded refuses nothing decoded",
			code: `function Decoded(walk: ExternalWalk, value: unknown): Compiled {
  const decoded = DecodeValue(value, walk.context);
  if (!decoded) {
    throw new Error(\`A payload value for '\${walk.path}' could not be read\`);
  }
  return decoded;
}`,
		},
		{
			name: "postgres@887faab src/implementations/database/payload.ts:109 Decoded asserts then returns",
			code: `function Decoded(walk: PayloadWalk, value: unknown): Compiled {
  const compiled = DecodeValue(value, walk.context);
  assert(compiled, "A supplied payload value always decodes");
  return compiled;
}`,
		},
		"function parseUser(value: unknown): User { return userSchema.parse(value); }",
		{
			name: "a callee imported from another module is checked where it is declared",
			code: `import { DecodeValue } from "./value";
function Decoded(value: unknown): Compiled { return DecodeValue(value); }`,
		},
		{
			name: "a decoder imported from a package",
			code: `import { parse } from "valibot";
function parseUser(value: unknown): User { return parse(userSchema, value); }`,
		},
		{
			name: "a decoder reached through a namespace import",
			code: `import * as v from "valibot";
function parseUser(value: unknown): User { return v.parse(userSchema, value); }`,
		},
		{
			name: "a schema declared in the same file is the decoder, not a wrapper around one",
			code: `const userSchema = z.object({ id: z.string() });
function parseUser(value: unknown): User { return userSchema.parse(value); }`,
		},
		{
			name: "a schema held in a field of this",
			code: "class Users { constructor(private readonly schema: Schema) {} parse(value: unknown): User { return this.schema.parse(value); } }",
		},
		{
			name: "arguments read in a sibling function does not refuse this one",
			code: "function parseUser(value: unknown): User { return userSchema.parse(value); }\nfunction forward() { return sink(arguments[0]); }",
		},
		"const parseUser = (value: unknown): User => userSchema.parse(value);",
		"const parseUser = function (value: unknown): User { return userSchema.parse(value); };",
		"class Users { parse(value: unknown): User { return userSchema.parse(value); } }",
		"const users = { parse(value: unknown): User { return userSchema.parse(value); } };",
		"function parseUser(value?: unknown): User { return userSchema.parse(value); }",
		"function parseUser(value: unknown = {}): User { return userSchema.parse(value); }",
		"function parseUser(value: unknown): User { return v.parse(userSchema, value); }",
		"function parseUser(value: unknown): User { return codec.decode(value); }",
		"function readUser(value: unknown): User { return parseUser(value); }",
		"function readUser(value: unknown): User { return ParseUser(value); }",
		"function readUser(value: unknown): User { return decodeUser(value); }",
		"function value(value: unknown): User { return userSchema.parse(value); }",
		{
			name: "an awaited parse returned in place",
			code: "async function parseUser(value: unknown): Promise<User> { return await userSchema.parseAsync(value); }",
		},
		{
			name: "a safeParse whose data is returned after the refusal",
			code: "function parseUser(value: unknown): User { const parsed = userSchema.safeParse(value); if (!parsed.success) throw new Refusal(parsed.error); return parsed.data; }",
		},
		{
			name: "a safeParse whose data is returned before the refusal",
			code: "function parseUser(value: unknown): User { const parsed = userSchema.safeParse(value); if (parsed.success) return parsed.data; throw new Refusal(parsed.error); }",
		},
		{
			name: "the data of a safeParse read in place",
			code: "function parseUser(value: unknown): User | undefined { return userSchema.safeParse(value).data; }",
		},
		{
			name: "a promise of the parsed value",
			code: "function parseUser(value: unknown): Promise<User> { return userSchema.parseAsync(value); }",
		},
		{
			name: "an awaited safeParseAsync",
			code: "async function parseUser(value: unknown): Promise<User> { const parsed = await userSchema.safeParseAsync(value); if (!parsed.success) throw new Refusal(parsed.error); return parsed.data; }",
		},
		{
			name: "a refusal translated in a catch clause",
			code: "function parseUser(value: unknown): User { try { return userSchema.parse(value); } catch (error) { throw new Refusal(error); } }",
		},
		{
			name: "the refused input read back through a second schema",
			code: 'function parseDeclaration(input: unknown): Declaration { const parsed = declarationSchema.safeParse(input); if (parsed.success) return parsed.data; const key = keySchema.safeParse(input); throw new Refusal(key.success ? key.data.key : "?"); }',
		},
	],
	invalid: [
		{
			name: "an unknown parameter passed through untouched",
			code: "function forward(value: unknown): void { sink(value); }",
			errors: [error],
		},
		{
			name: "interface-core@4bf5b93 src/proxies.ts:124 a reader that is not a schema or decoder",
			code: "export function GetInterfaceProxyIdentity(value: unknown): string | undefined { return readBrand(value)?.identity; }",
			errors: [error],
		},
		{
			name: "dms-frontend@e1a1fba src/project-modules.ts:172 a callback handed the value",
			code: "function computeConfigVars(id: string, provider: ConfigVarsProvider, config: unknown): ConfigVars { return provider.configVars(config) ?? {}; }",
			errors: [error],
		},
		{
			name: "dms-automation@29b56c5 src/runtime/resolveInputs.ts:50 an unknown parameter stored",
			code: "class Outputs { setOutput(nodeId: string, value: unknown): void { this.outputs.set(nodeId, value); } }",
			errors: [error],
		},
		{
			name: "mongodb@cf32203 src/implementations/database/expression.ts:130 an unknown parameter stored in a stage",
			code: 'class Stage { stage_date_during(low: unknown, high: unknown) { this.stages.push({ $during: [low, high] }); return this; } }',
			errors: [{ ...error, data: { parameter: "low" } }, { ...error, data: { parameter: "high" } }],
		},
		{
			name: "an unknown parameter returned as unknown",
			code: "function same(value: unknown): unknown { return value; }",
			errors: [error],
		},
		{
			name: "postgres@887faab src/implementations/database/stages-selection.ts:115 an unknown parameter returned in a list",
			code: "function KeyList(argument: unknown): unknown[] { return Array.isArray(argument) ? argument : [argument]; }",
			errors: [error],
		},
		{
			name: "a schema result declared unknown",
			code: "function parse(value: unknown): unknown { return schema.parse(value); }",
			errors: [error],
		},
		{
			name: "a schema result declared a promise of unknown",
			code: "function parse(value: unknown): Promise<unknown> { return schema.parseAsync(value); }",
			errors: [error],
		},
		{
			name: "a schema result declared any",
			code: "function parse(value: unknown): any { return schema.parse(value); }",
			errors: [error],
		},
		{
			name: "a schema result with no declared return type, which can infer unknown",
			code: "const parse = (value: unknown) => schema.parse(value);",
			errors: [error],
		},
		{
			name: "a value validated and then returned raw",
			code: "function parse(value: unknown): User { schema.parse(value); return value; }",
			errors: [error],
		},
		{
			name: "a value validated and then passed on raw",
			code: "function parse(value: unknown): User { const parsed = schema.parse(value); sink(value); return parsed; }",
			errors: [error],
		},
		{
			name: "dms-ai@039880e src/index.ts:15 a parsed value stored, not returned",
			code: "export function construct(config: unknown): void { setConfig(ConfigSchema.safeParse(config).data ?? {}); }",
			errors: [error],
		},
		{
			name: "dms-mailing@e907e5d src/data/templates-table.ts:314 a parsed value written, not returned",
			code: `export async function saveDetails(body: unknown, author: string): Promise<void> {
  const details = assertValidation(body, (value) => templateDetailsSchema.parse(value), () => INVALID_TEMPLATE);
  await GetModel(TemplateModel).updateFields({ name: details.name, updatedBy: author });
}`,
			errors: [error],
		},
		{
			name: "dms-ai@039880e sidecar/src/mcp/tools/builder.ts:29 a success flag, not the parsed value",
			code: `function hasExprSentinel(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasExprSentinel);
  if (EXPR_SENTINEL.safeParse(value).success) return true;
  const record = EXPR_CARRIER.safeParse(value);
  return record.success && Object.values(record.data).some(hasExprSentinel);
}`,
			errors: [error],
		},
		{
			name: "a success flag read from a binding",
			code: "function isUser(value: unknown): boolean { const parsed = userSchema.safeParse(value); return parsed.success; }",
			errors: [error],
		},
		{
			name: "postgres@887faab src/implementations/database/stages-selection.ts:100 a decoded value turned into something else",
			code: `function KeyValue(selection: KeySelection, key: unknown, column: Compiled): string {
  const value = RequireOperand(DecodeValue(key, selection.context), selection.stage);
  return StoredAs(value, column.type).sql;
}`,
			errors: [error],
		},
		{
			name: "a parsed value turned into something else",
			code: "function parse(value: unknown): User { return toUser(schema.parse(value)); }",
			errors: [error],
		},
		{
			name: "a fallback returned in place of the parsed value",
			code: "function parse(value: unknown): Config { return schema.safeParse(value).data ?? {}; }",
			errors: [error],
		},
		{
			name: "another value returned on an early path",
			code: "function parse(value: unknown): User { if (cached) return cached; return schema.parse(value); }",
			errors: [error],
		},
		{
			name: "a bare return on an early path",
			code: "function parse(value: unknown): User | undefined { if (skip) return; return schema.parse(value); }",
			errors: [error],
		},
		{
			name: "dms-media@df1cc55 src/declared/records.ts:51 the refused input read again by hand",
			code: `export function parseDeclaration<Output>(kind: MediaDeclarationKind, input: unknown, schema: ZodType<Output, ZodTypeDef, unknown>): Output {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const key = isObjectLike(input) && "key" in input ? input.key : undefined;
  throw new MediaDeclarationError(kind, isString(key) ? key : "?", describeDeclarationIssues(parsed.error));
}`,
			errors: [error],
		},
		{
			name: "a parameter typed as a union with unknown",
			code: "function parse(value: string | unknown): User { return schema.parse(value); }",
			errors: [error],
		},
		{
			name: "a schema fed a wrapper around the parameter",
			code: "function parse(value: unknown): User { return schema.parse({ value }); }",
			errors: [error],
		},
		{
			name: "a schema fed an assertion of the parameter",
			code: "function parse(value: unknown): User { return schema.parse(value as Input); }",
			errors: [error],
		},
		{
			name: "JSON.parse fed an assertion of the parameter",
			code: "function read(raw: unknown): User { return JSON.parse(raw as string); }",
			errors: [error],
		},
		{
			name: "postgres@887faab src/test/unit/invalid-fixture.ts:9 an assertion, not a parse",
			code: "export function NotAString(value: unknown): string { return value as string; }",
			errors: [error],
		},
		{
			name: "two decoder-named functions that call each other decode nothing",
			code: `export function parseA(value: unknown): Parsed { return parseB(value); }
export function parseB(value: unknown): Parsed { return parseA(value); }`,
			errors: [error, error],
		},
		{
			name: "a decoder-named function that calls itself decodes nothing",
			code: "export function parseSelf(value: unknown): Parsed { return parseSelf(value); }",
			errors: [error],
		},
		{
			name: "a decoder-named wrapper over a function declared in the same file",
			code: `function decodeStore(value: unknown): Parsed { return value as Parsed; }
function read(value: unknown): Parsed { return decodeStore(value); }`,
			errors: [error, error],
		},
		{
			name: "a decoder-named arrow bound to a const in the same file",
			code: `const parseA = (value: unknown): Parsed => parseB(value);
const parseB = (value: unknown): Parsed => parseA(value);`,
			errors: [error, error],
		},
		{
			name: "a decoder-named callee passed in as a parameter",
			code: "function read(parse: Decoder, value: unknown): Parsed { return parse(value); }",
			errors: [error],
		},
		{
			name: "methods of one class that call each other through this",
			code: `class Parsers {
  parseA(value: unknown): Parsed { return this.parseB(value); }
  parseB(value: unknown): Parsed { return this.parseA(value); }
}`,
			errors: [error, error],
		},
		{
			name: "a static method of a class declared in the same file",
			code: `class Parsers { static parseA(value: unknown): Parsed { return Parsers.parseB(value); } static parseB(value: unknown): Parsed { return Parsers.parseA(value); } }`,
			errors: [error, error],
		},
		{
			name: "methods of an object literal declared in the same file",
			code: `const parsers = {
  parseA(value: unknown): Parsed { return parsers.parseB(value); },
  parseB(value: unknown): Parsed { return parsers.parseA(value); },
};`,
			errors: [error, error],
		},
		{
			name: "a method of an instance of a class declared in the same file",
			code: `class Parsers { parseB(value: unknown): Parsed { return parsers.parseA(value); } parseA(value: unknown): Parsed { return parsers.parseB(value); } }
const parsers = new Parsers();`,
			errors: [error, error],
		},
		{
			name: "the raw value read beside the decode through arguments",
			code: "function parseWithArguments(value: unknown): Parsed { console.log(arguments[0]); return schema.parse(value); }",
			errors: [error],
		},
		{
			name: "the arguments object handed on beside the decode",
			code: "function parseWithArguments(value: unknown): Parsed { sink(...arguments); return schema.parse(value); }",
			errors: [error],
		},
		{
			name: "arguments read inside a nested arrow, which shares them",
			code: "function parseWithArguments(value: unknown): Parsed { later(() => arguments[0]); return schema.parse(value); }",
			errors: [error],
		},
		{
			name: "a direct eval can read the parameter by name",
			code: "function parseWithEval(value: unknown): Parsed { sink(eval('value')); return schema.parse(value); }",
			errors: [error],
		},
		{
			name: "a callee whose name only starts like a decoder",
			code: "function parse(walk: Walk, value: unknown): Compiled { return Decoded(walk, value); }",
			errors: [error],
		},
		{
			name: "a callee named after validation is not on the decoder list",
			code: "function parse(value: unknown): User { return validateAndStore(value); }",
			errors: [error],
		},
		{
			name: "a parse inside a nested callback does not return from the function",
			code: "function parse(value: unknown): User[] { return items.map(() => schema.parse(value)); }",
			errors: [error],
		},
		{
			name: "a nested callback that returns the raw value",
			code: "function parse(value: unknown): User { later(() => value); return schema.parse(value); }",
			errors: [error],
		},
		{
			name: "a field destructured from a safe parse is not the parsed value",
			code: "function isUser(value: unknown): boolean { const { success } = userSchema.safeParse(value); return success; }",
			errors: [error],
		},
		{
			name: "a reassigned binding is not the parsed value",
			code: "function parse(value: unknown): User { let parsed = schema.parse(value); parsed = other; return parsed; }",
			errors: [error],
		},
		{
			name: "a binding that holds something else",
			code: "function parse(value: unknown, other: User): User { const parsed = other; schema.parse(value); return parsed; }",
			errors: [error],
		},
		{
			name: "the parse of another parameter does not cover this one",
			code: "function parse(value: unknown, extra: unknown): User { schema.parse(extra); return schema.parse(value); }",
			errors: [{ ...error, data: { parameter: "extra" } }],
		},
		{
			name: "two parameters, each with a return that is not its own parsed value",
			code: "function parsePair(left: unknown, right: unknown): Pair { const first = leftSchema.parse(left); if (first.single) return first; return rightSchema.parse(right); }",
			errors: [{ ...error, data: { parameter: "left" } }, { ...error, data: { parameter: "right" } }],
		},
		{
			name: "a parameter reassigned before the parse",
			code: "function parse(value: unknown): User { value = fallback; return schema.parse(value); }",
			errors: [error],
		},
		{
			name: "an unused unknown parameter beside a decoded one",
			code: "function parse(value: unknown, extra: unknown): User { return schema.parse(value); }",
			errors: [{ ...error, data: { parameter: "extra" } }],
		},
		{
			name: "an unknown parameter the body never reads",
			code: "function parse(value: unknown): User { return schema.parse(other); }",
			errors: [error],
		},
		{
			name: "a constructor that parses has no return to read",
			code: "class Users { constructor(value: unknown) { this.user = schema.parse(value); } }",
			errors: [error],
		},
		{
			name: "a signature has no body to read",
			code: "type Parse = (value: unknown) => User;",
			errors: [error],
		},
		{
			name: "a declared function has no body to read",
			code: "declare function parse(value: unknown): User;",
			errors: [error],
		},
		{
			name: "interface-api-util@cc740f8 src/index.ts:72 a function type in a signature",
			code: "function assertValidation<T>(body: T, errorFunc?: (err: unknown) => string): void {}",
			errors: [{ ...error, data: { parameter: "err" } }],
		},
	],
});
