import { spawn } from "node:child_process";
import { AB_BIN, benchEnv, withSystemLibs } from "./paths.mjs";

/**
 * @param {Record<string, any>} step The step
 * @param {string} baseUrl The site
 * @param {string} pngPath Where a screenshot goes
 * @returns {string[]} The agent-browser arguments for the step
 */
export function abArgs(step, baseUrl, pngPath) {
  switch (step.op) {
    case "goto":
      return ["open", new URL(step.path, baseUrl).href];
    case "snapshot":
      return ["snapshot"];
    case "click":
      return [
        "find",
        "role",
        step.role,
        "click",
        "--name",
        step.name,
        "--exact",
      ];
    case "fill":
      return [
        "find",
        "role",
        step.role,
        "fill",
        step.value,
        "--name",
        step.name,
        "--exact",
      ];
    case "press":
      return ["press", step.key];
    case "waitUrl":
      return ["wait", "--url", step.glob];
    case "waitText":
      return ["wait", "--text", step.text];
    case "screenshot":
      return ["screenshot", ...(step.full ? ["--full"] : []), pngPath];
    case "eval":
      return ["eval", step.js];
    case "url":
      return ["get", "url"];
    default:
      throw new Error(`unknown op ${step.op}`);
  }
}

/**
 * Runs one agent-browser command as its own process, the way an agent would.
 *
 * @param {string[]} args The arguments after the program name
 * @param {{ session: string, program?: string, prefix?: string[] }} options Session and program
 * @returns {Promise<{ stdout: string, stderr: string }>} The output
 */
export function runAb(args, { session, program = AB_BIN, prefix = [] }) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, [...prefix, "--session", session, ...args], {
      env: withSystemLibs(benchEnv()),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve({ stdout, stderr })
        : reject(
            new Error(
              `ab ${args.join(" ").slice(0, 80)} exited ${code}: ${(stderr || stdout).trim().slice(0, 160)}`,
            ),
          ),
    );
  });
}

/**
 * @param {string} stdout Output of `agent-browser eval`
 * @returns {unknown} The JSON value, or the trimmed text when it is not JSON
 */
export function parseEval(stdout) {
  const text = stdout.trim();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
