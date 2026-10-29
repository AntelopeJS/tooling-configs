import type { VerifyKind } from "./kinds.ts";

/** What differs per kind in the synced SKILL.md: who the user is, what `new` prepares and what the pack ships. */
export interface KindText {
  description: string;
  title: string;
  user: string;
  launch: string;
  builtins: string;
  layer: string;
  smoke: string;
  gotchas: string[];
}

const INTERFACE: KindText = {
  description:
    "Drive this AntelopeJS interface the way a module author does: pack it, load it in `ajs project dev` next to a stub provider wired through ImplementInterface and a consumer, call every declared function through core, and check the minor-bump rule against the published version. Use to prove a change to the interface works before merge, to verify a PR, or to check that a seeded break is caught.",
  title: "Verify interface",
  user: "The user of an interface is a module author: one module implements it, others import it and call its functions through core.",
  launch:
    "`new` runs the setup (`pnpm run build` by default), then packs the interface with `pnpm pack` and extracts it, so journeys load what npm would publish, `files` and `exports` included.",
  builtins: `- \`every-function\`: a fixture project loads the packed interface with a stub provider and a consumer module. The consumer walks the loaded interface, and every function the \`.d.ts\` files declare is called through core:
  - an async proxy answers the stub's echo, and the stub's call log shows the same arguments (the second view);
  - a registering proxy registers and unregisters, and the stub logs both;
  - an event proxy delivers the emitted arguments to a registered handler;
  - a plain function runs the \`interface.calls\` hook of \`verify.config.ts\` and must return its \`expect\`; one only providers call is listed in \`interface.providerSide\` with why.
  A declared function with none of these fails the journey.
- \`minor-bump\`: reads the declared functions of the packed head and of the published version (\`npm pack <name>@<latest>\`). An added, changed or removed function needs a release of at least the next minor. The release is the head version when it is already bumped, otherwise what changelogen makes of the change title (\`new --title\`) or the commit subjects since the base.`,
  layer: `- \`interface.provide(api)\` runs in the stub provider after the generic stubs attach, for example to hand a stub client to \`internal.SetClient\`.
- \`interface.calls["<entry>:<path>"]\` calls a plain exported function from the consumer and states the value it must return.
- \`interface.providerSide["<entry>:<path>"]\` names a function only providers call, with the reason.`,
  smoke: "`every-function`",
  gotchas: [
    "A function the consumer awaits forever, such as a getter no provider resolved, fails after 15 seconds with a `Timeout` value.",
    "`minor-bump` needs the npm registry. Without it the journey is not verified, never passed.",
  ],
};

const MODULE: KindText = {
  description:
    "Drive this AntelopeJS implementation module the way an app developer does: install it as `local` in a fixture project, run its backing services in Docker on free ports, call its interfaces from a consumer module and read stored state back with the service's native client. Use to prove a change to the module works before merge, to verify a PR, or to check that a seeded break is caught.",
  title: "Verify module",
  user: "The user of a module is an app developer: they add it to `antelope.config.ts`, configure it, and other modules call the interfaces it implements.",
  launch:
    "`new` runs the setup (`pnpm run build` by default), then starts every `services` entry of `verify.config.ts` in its own Docker container on a free loopback port, named `<prefix>-<repo>-<service>-<run>` (`VERIFY_CONTAINER_PREFIX`, default `verify`), and waits for each readiness command. A provider with sandbox keys in `saas.env` records the missing ones.",
  builtins:
    "- `module-dev`: a fixture project installs the module as `local` with `moduleConfig(services)` as its config, plus a consumer module. `ajs project dev` must answer, the consumer must load every implemented interface, Ctrl+C must exit 130 and the port must refuse afterwards.",
  layer: `- \`services\`: image, port, readiness command and a \`reset\` command run before every journey, so each starts from a clean state.
- \`moduleConfig(services)\`: the module's configuration, pointing at the run's containers.
- \`saas: { env, sandbox }\`: a SaaS module runs against the provider's sandbox with keys from these environment variables. Without every key, each journey is not verified and so is the verdict, never PASS.
- \`journeys\`: the module's own journeys. Each writes through the module with \`context.call(...)\` and reads the result back with \`context.native(...)\` (\`redis-cli\`, \`mongosh\`, \`psql\`, the Mailpit API) inside the service container.`,
  smoke: "`module-dev` and one write read back through the native client",
  gotchas: [
    "Every container is the run's own. Never point a journey at a shared instance such as a developer's local database.",
    "A sandbox key missing from the environment is a NOT VERIFIED verdict, which sets status `verify` to `error`.",
  ],
};

const TEMPLATE: KindText = {
  description:
    "Drive this AntelopeJS template the way a new user does: scaffold a project with `ajs project init` from an offline interfaces manifest, install it, run its own `pnpm run checks`, run `ajs project dev --watch` and hit its welcome page, endpoint or ready line. Use to prove a change to the template works before merge, to verify a PR, to run the release canary, or to check that a seeded break is caught.",
  title: "Verify template",
  user: "The user of a template is someone running `ajs project init --template`: they get a copy of the whole repository and expect it to install, pass its checks and run.",
  launch:
    "`new` copies the working tree, uncommitted changes included, into a local git repository, and lists it in an offline interfaces manifest (`templates`, or `projectTemplates` when `template.project` is set) under `template.name`. Journeys point `ajs config set git` at it, so no step reaches GitHub.",
  builtins: `- \`scaffold-dev\`: \`ajs project init <app> --template <name> --pm pnpm --git-init\`, \`pnpm install --frozen-lockfile\`, then \`ajs project dev --watch\` with \`PORT\` set until \`template.probe\` answers: a path and status on that port, or a \`log\` line followed by \`settleMs\` of still running. Ctrl+C must exit 130.
- \`scaffold-checks\`: the same scaffold and install, then the project's own \`pnpm run checks\`.`,
  layer: `- \`template.name\`: the listing name users pass to \`--template\`.
- \`template.project\`: list it under \`projectTemplates\`.
- \`template.probe\`: \`path\`, \`status\` and \`body\` for an HTTP welcome page or endpoint, or \`log\` and \`settleMs\` for a template that serves nothing.`,
  smoke: "`scaffold-dev` and `scaffold-checks`",
  gotchas: [
    "`ajs` copies the whole repository, `.agents/` and `.claude/` included, so the scaffolded project carries this skill too.",
    "Every file a user gets is user-facing here, tests included; only `.agents/`, `.claude/` and `.github/` are not.",
  ],
};

/** The kind-specific text of each shared skill. */
export const KIND_TEXT = {
  interface: INTERFACE,
  module: MODULE,
  template: TEMPLATE,
} satisfies { [Kind in VerifyKind]: KindText };
