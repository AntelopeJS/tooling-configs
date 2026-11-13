import { RuleTester } from "oxlint/plugins-dev";

import { noUnknownParametersRule } from "./no-unknown-parameters.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "unknownParameter" };

/** antelopejs@0e6a3db src/core/modules/module.ts:176 `Module.provide` and :188 `Module.construct`. */
const MODULE = `import { Logging } from "@antelopejs/interface-core/logging";
import { RunWithModuleContext } from "./context";
export class Module {
  async provide(config: unknown): Promise<ConfigVars | void> {
    if (this.lifecycle.state !== ModuleState.Loaded) {
      return;
    }
    return RunWithModuleContext(this.executionContext, async () => {
      await this.ensureLoaded();
      return this.lifecycle.provide(config);
    });
  }
  async construct(config: unknown): Promise<void> {
    if (this.lifecycle.state !== ModuleState.Loaded) {
      Logger.Info(\`Module \${this.id} already constructed\`);
      return;
    }
    await RunWithModuleContext(this.executionContext, async () => {
      await this.ensureLoaded();
      await this.lifecycle.construct(config);
    });
  }
}`;

/** antelopejs@0e6a3db src/core/modules/module-lifecycle.ts:41 `ModuleLifecycle.provide` and :52 `ModuleLifecycle.construct`. */
const MODULE_LIFECYCLE = `import { Events } from "@antelopejs/interface-core/modules";
export class ModuleLifecycle {
  private callbacks?: ModuleCallbacks;
  provide(config: unknown): Promise<ConfigVars | void> {
    return this.enqueue(async () => {
      if (this._state !== ModuleState.Loaded) {
        return undefined;
      }
      return this.callbacks?.provide?.(config) ?? undefined;
    });
  }
  construct(config: unknown): Promise<void> {
    return this.enqueue(() => {
      if (this._state !== ModuleState.Loaded) {
        return Promise.resolve();
      }
      return ModuleDiagnostics.construct.tracePromise(async () => {
        this._state = ModuleState.Constructed;
        await this.callbacks?.construct?.(config);
        Events.ModuleConstructed.emit(this.moduleId);
      }, this.diagnosticsContext());
    });
  }
}`;

/** antelopejs@0e6a3db src/types/module.types.ts:11 `ModuleCallbacks.construct`, the contract the forwarders hand the config to. */
const MODULE_CALLBACKS = `export interface ModuleCallbacks {
  construct?(config: unknown): Promise<void> | void;
}`;

tester.run("anti-slop/no-unknown-parameters at a parameter only forwarded", noUnknownParametersRule, {
	valid: [
		{
			name: "antelopejs Module.provide and construct: fails one that refuses a forward inside a closure or a void promise",
			code: MODULE,
		},
		{
			name: "antelopejs ModuleLifecycle.provide and construct: fails one that refuses an optional call or a forward under ??",
			code: MODULE_LIFECYCLE,
		},
		{
			name: "a method forwarding to this.x.y(config): fails one that refuses member calls",
			code: "class Host { start(config: unknown): void { this.runner.start(config); } }",
		},
		{
			name: "an optional-call forward: fails one that misses a call wrapped in a chain",
			code: "class Host { start(config: unknown): void { this.hooks?.start?.(config); } }",
		},
		{
			name: "a forward to an imported function: fails one that refuses imports",
			code: 'import { register } from "./registry";\nfunction add(config: unknown): void { register(config); }',
		},
		{
			name: "a forward to a same-file function whose unknown parameter is exempt: fails one that refuses same-file callees",
			code: "function describe(input: unknown): string { return String(input); }\nfunction label(config: unknown): string { return describe(config); }",
		},
		{
			name: "a forward to a same-file function declared after it: fails one that judges a callee before walking it",
			code: "function label(config: unknown): string { return describe(config); }\nfunction describe(input: unknown): string { return String(input); }",
		},
		{
			name: "two forwards of the same parameter: fails one that accepts only a single read",
			code: "class Host { start(config: unknown): void { this.log.write(config); this.runner.start(config); } }",
		},
	],
	invalid: [
		{
			name: "antelopejs ModuleCallbacks.construct is a signature with no body: fails one that exempts what it cannot walk",
			code: MODULE_CALLBACKS,
			errors: [{ ...error, data: { parameter: "config" } }],
		},
		{
			name: "a forward plus a property access: fails one that judges only the first read",
			code: "class Host { start(config: unknown): void { this.runner.start(config); this.name = config.name; } }",
			errors: [error],
		},
		{
			name: "a forward plus a cast: fails one that accepts a call argument under as",
			code: "class Host { start(config: unknown): void { this.runner.start(config as Settings); } }",
			errors: [error],
		},
		{
			name: "a spread into the call: fails one that accepts any argument position",
			code: "class Host { start(config: unknown): void { this.runner.start(...config); } }",
			errors: [error],
		},
		{
			name: "a forward plus String(config): fails one that treats converters as neutral beside a forward",
			code: "class Host { start(config: unknown): string { this.runner.start(config); return String(config); } }",
			errors: [error],
		},
		{
			name: "a forward plus JSON.stringify(config): fails one that counts a converter call as a forward",
			code: "class Host { start(config: unknown): string { this.runner.start(config); return JSON.stringify(config); } }",
			errors: [error],
		},
		{
			name: "a forward to a same-file function whose parameter is any: fails one that trusts every same-file callee",
			code: "function keep(input: any): void { cache.push(input); }\nfunction add(config: unknown): void { keep(config); }",
			errors: [error],
		},
		{
			name: "a forward to a same-file function whose unknown parameter is reported: fails one that checks only the annotation",
			code: "function keep(input: unknown): void { cache.push(input); }\nfunction add(config: unknown): void { keep(config); }",
			errors: [
				{ ...error, data: { parameter: "input" } },
				{ ...error, data: { parameter: "config" } },
			],
		},
		{
			name: "a forward to the function itself: fails one that counts recursion as a forward",
			code: "function add(config: unknown, depth: number): void { if (depth > 0) add(config, depth - 1); }",
			errors: [error],
		},
		{
			name: "a forwarder returning unknown: fails one that skips the return type",
			code: "class Host { start(config: unknown): unknown { return this.runner.start(config); } }",
			errors: [error],
		},
		{
			name: "a forwarder answering boolean: fails one that exempts a yes-or-no answer about the input",
			code: 'import { readBrand } from "./brand";\nfunction isBranded(value: unknown): boolean { return readBrand(value) !== undefined; }',
			errors: [error],
		},
		{
			name: "a forward to a global the file never declares: fails one that trusts any identifier callee",
			code: "function forward(value: unknown): void { sink(value); }",
			errors: [error],
		},
		{
			name: "a forward to a callback another parameter hands in: fails one that trusts a member of a parameter",
			code: "function computeConfigVars(provider: ConfigVarsProvider, config: unknown): ConfigVars { return provider.configVars(config) ?? {}; }",
			errors: [error],
		},
		{
			name: "a value kept by a collection's set: fails one that treats a store as a forward",
			code: "class Outputs { setOutput(nodeId: string, value: unknown): void { this.outputs.set(nodeId, value); } }",
			errors: [error],
		},
		{
			name: "a forward to a decoder by name: fails one that lets a forward skip the parse-boundary check",
			code: "class Users { read(value: unknown): User { return this.codec.parse(value); } }",
			errors: [error],
		},
		{
			name: "a forward to a validator by name: fails one that trusts a helper running whatever validator it is handed",
			code: 'import { assertValidation } from "@antelopejs/interface-api-util";\nfunction readBody(body: unknown): Body { return assertValidation(body, check); }',
			errors: [error],
		},
		{
			name: "a forward through arguments: fails one that ignores implicit reads",
			code: "class Host { start(config: unknown): void { this.runner.start(config, arguments[0]); } }",
			errors: [error],
		},
	],
});
