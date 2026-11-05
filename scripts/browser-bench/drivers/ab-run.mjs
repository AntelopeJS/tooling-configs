import { AB_BIN, AB_WRAPPER } from "../lib/paths.mjs";
import { abArgs, parseEval, runAb } from "../lib/ab-ops.mjs";
import { ACCOUNTS, VIEWPORT } from "../lib/steps.mjs";
import { main } from "../lib/scenario.mjs";

main((config) => {
  const options =
    config.variant === "wrapper"
      ? { program: process.execPath, prefix: [AB_WRAPPER] }
      : { program: AB_BIN, prefix: [] };
  const sessions = (scenario) =>
    scenario === "accounts" ? ACCOUNTS : ["bench"];
  const run = (args, session) => runAb(args, { session, ...options });
  const closeAll = async (scenario) => {
    for (const session of sessions(scenario)) await run(["close"], session);
  };
  let scenarioName = "";

  return {
    async start(scenario, recorder) {
      scenarioName = scenario;
      if (scenario === "cold") return;
      for (const session of sessions(scenario))
        await recorder.step(`viewport ${session}`, () =>
          run(
            [
              "set",
              "viewport",
              String(VIEWPORT.width),
              String(VIEWPORT.height),
            ],
            session,
          ),
        );
    },
    async execute(step, pngPath) {
      const { stdout } = await run(
        abArgs(step, config.baseUrl, pngPath),
        step.account ?? "bench",
      );
      if (step.op === "snapshot") return { text: stdout };
      if (step.op === "eval") return { value: parseEval(stdout) };
      if (step.op === "url") return { value: stdout.trim() };
      return {};
    },
    finish: closeAll,
    release: () => run(["open", "about:blank"], "bench").then(() => undefined),
    dispose: async () => {
      await closeAll(scenarioName).catch(() => undefined);
    },
  };
});
