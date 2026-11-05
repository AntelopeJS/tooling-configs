import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { PW_ENTRY } from "../lib/paths.mjs";
import { contextOptions, launchOptions, runPwStep } from "../lib/pw-ops.mjs";

const [variant] = process.argv.slice(2);
const { chromium } = await import(pathToFileURL(PW_ENTRY).href);
const browser = await chromium.launch(launchOptions(variant));
browser.on("disconnected", () => process.exit(0));

const contexts = new Map();
const pages = new Map();

const pageFor = async (account) => {
  if (!pages.has(account)) {
    if (!contexts.has(account))
      contexts.set(account, await browser.newContext(contextOptions()));
    pages.set(account, await contexts.get(account).newPage());
  }
  return pages.get(account);
};

const handle = async (request) => {
  if (request.op === "closeAccount") {
    await contexts.get(request.account)?.close();
    contexts.delete(request.account);
    pages.delete(request.account);
    return {};
  }
  const page = await pageFor(request.account);
  return runPwStep(page, request.step, request.baseUrl, request.pngPath);
};

const server = createServer((incoming, outgoing) => {
  const chunks = [];
  incoming.on("data", (chunk) => chunks.push(chunk));
  incoming.on("end", () => {
    Promise.resolve()
      .then(() => handle(JSON.parse(Buffer.concat(chunks).toString("utf8"))))
      .then((outcome) => ({ ok: true, ...outcome }))
      .catch((error) => ({
        ok: false,
        error: String(error?.message ?? error).slice(0, 300),
      }))
      .then((answer) => outgoing.end(JSON.stringify(answer)));
  });
});
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(`${server.address().port}\n`);
});
