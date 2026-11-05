import { spawn } from "node:child_process";
import { once } from "node:events";
import { DRIVERS } from "../lib/paths.mjs";
import { main } from "../lib/scenario.mjs";

const SERVER = `${DRIVERS}/pw-server.mjs`;
const CLIENT = `${DRIVERS}/pw-client.mjs`;

/**
 * @param {string[]} args Node arguments
 * @returns {Promise<string>} What the process printed
 */
function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(stdout)
        : reject(new Error(`client exited ${code}: ${stderr.slice(0, 200)}`)),
    );
  });
}

main((config) => {
  let server;
  let port = 0;

  const call = async (request) => {
    const answer = JSON.parse(
      await runNode([CLIENT, String(port), JSON.stringify(request)]),
    );
    if (!answer.ok) throw new Error(answer.error);
    return answer;
  };

  const stop = async () => {
    if (!server || server.exitCode !== null) return;
    server.kill("SIGTERM");
    await once(server, "exit");
  };

  return {
    async start(_scenario, recorder) {
      await recorder.step("launch", async () => {
        server = spawn(process.execPath, [SERVER, config.variant], {
          stdio: ["ignore", "pipe", "inherit"],
        });
        const [chunk] = await Promise.race([
          once(server.stdout, "data"),
          once(server, "exit").then(() => {
            throw new Error("server exited before listening");
          }),
        ]);
        port = Number(String(chunk).trim());
      });
    },
    execute: (step, pngPath) =>
      call({
        account: step.account ?? "main",
        op: "step",
        step,
        baseUrl: config.baseUrl,
        pngPath,
      }),
    finish: stop,
    release: () =>
      call({ account: "main", op: "closeAccount" }).then(() => undefined),
    dispose: stop,
  };
});
