const WALK = String.raw`
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

const entries = JSON.parse(process.env.VERIFY_ENTRIES || "{}");

function load(name, entry) {
  return require(entry === "." ? name : name + "/" + entry.replace(/^\.\//, ""));
}

function isClass(value) {
  return /^class[\s{]/.test(Function.prototype.toString.call(value));
}

function kindOf(value) {
  if (typeof value === "function") {
    if (value.proxy && typeof value.proxy.onCall === "function") return "async";
    return isClass(value) ? "class" : "function";
  }
  if (!value || typeof value !== "object") return "value";
  if (typeof value.onCall === "function" && typeof value.call === "function") return "async";
  if (typeof value.onHandlers === "function" || typeof value.onRegister === "function") return "registering";
  if (typeof value.emit === "function" && typeof value.register === "function") return "event";
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? "namespace" : "value";
}

function walk(value, keys, visit) {
  for (const key of Object.keys(value)) {
    if (key === "__esModule") continue;
    const member = value[key];
    const kind = kindOf(member);
    if (kind === "namespace") {
      if (keys.length < 4) walk(member, [...keys, key], visit);
      continue;
    }
    visit([...keys, key], kind, member);
  }
}

async function loadHooks() {
  if (!process.env.VERIFY_CONFIG) return {};
  const config = (await import(pathToFileURL(process.env.VERIFY_CONFIG).href)).default;
  return (config && config.interface) || {};
}
`;

/** The driver module: the consumer every fixture project loads, answering HTTP calls by calling interfaces through core. */
export const DRIVER_SOURCE = String.raw`"use strict";
const http = require("node:http");
${WALK}
const TIMEOUT_MS = 15000;
const interfaces = Object.keys(entries);
let server;
let hooks = {};

function settle(value) {
  return Promise.race([
    Promise.resolve(value),
    new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error("did not settle within " + TIMEOUT_MS + " ms"), { name: "Timeout" })), TIMEOUT_MS).unref()),
  ]);
}

function serializable(value) {
  try {
    return JSON.parse(JSON.stringify(value === undefined ? null : value));
  } catch {
    return { unserializable: String(value) };
  }
}

function target(body) {
  const name = body.interface || interfaces[0];
  let owner;
  let value = load(name, body.entry || ".");
  for (const key of body.path) {
    owner = value;
    value = value[key];
  }
  return { owner, value };
}

function surface() {
  const found = [];
  for (const name of interfaces) {
    for (const entry of entries[name]) {
      walk(load(name, entry), [], (keys, kind) => found.push({ interface: name, entry, path: entry + ":" + keys.join("."), kind }));
    }
  }
  return found;
}

async function call(body) {
  const { owner, value: member } = target(body);
  const args = body.args || [];
  let value = await settle(kindOf(member) === "async" && typeof member !== "function" ? member.call(...args) : member.apply(owner, args));
  for (const [method, ...rest] of body.chain || []) value = await settle(value[method](...rest));
  return value;
}

async function registering(body) {
  const { value: proxy } = target(body);
  await settle(proxy.register("verify-registration", () => "verify-handler"));
  await settle(proxy.unregister("verify-registration"));
  return "registered and unregistered";
}

async function event(body) {
  const { value: proxy } = target(body);
  let received = null;
  const handler = (...args) => {
    received = args;
  };
  proxy.register(handler);
  proxy.emit(...(body.args || []));
  proxy.unregister(handler);
  return received;
}

async function hook(body) {
  const entry = body.path.slice(0, body.path.indexOf(":"));
  const found = (hooks.calls || {})[body.path];
  if (!found) throw new Error("verify.config.ts has no interface.calls hook for " + body.path);
  return found.call(load(body.interface || interfaces[0], entry));
}

const ROUTES = { "/surface": async () => surface(), "/call": call, "/registering": registering, "/event": event, "/hook": hook };

async function answer(request) {
  if (request.url === "/health") return { ok: true };
  const route = ROUTES[request.url];
  if (!route) return { ok: false, error: { name: "NotFound", message: request.url } };
  let text = "";
  for await (const chunk of request) text += chunk;
  try {
    return { ok: true, value: serializable(await route(text ? JSON.parse(text) : {})) };
  } catch (error) {
    return { ok: false, error: { name: (error && error.name) || "Error", message: String((error && error.message) || error) } };
  }
}

exports.construct = function construct() {};
exports.start = async function start() {
  hooks = await loadHooks();
  server = http.createServer((request, response) => {
    answer(request).then((result) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(result));
    });
  });
  await new Promise((resolve) => server.listen(Number(process.env.VERIFY_DRIVER_PORT), "127.0.0.1", resolve));
};
exports.stop = function stop() {
  if (server) server.close();
};
exports.destroy = function destroy() {};
`;

/** The stub provider module of the interface kind: implements every proxy of the interface through ImplementInterface and logs each call. */
export const STUB_SOURCE = String.raw`"use strict";
const { ImplementInterface } = require("@antelopejs/interface-core");
${WALK}
function note(path, args) {
  fs.appendFileSync(process.env.VERIFY_CALL_LOG, JSON.stringify({ path, args }) + "\n");
}

function place(tree, keys, leaf) {
  let node = tree;
  for (const key of keys.slice(0, -1)) node = node[key] = node[key] || {};
  node[keys[keys.length - 1]] = leaf;
}

function stubs(entry, api) {
  const tree = {};
  walk(api, [], (keys, kind) => {
    const path = entry + ":" + keys.join(".");
    if (kind === "async") place(tree, keys, (...args) => (note(path, args), { stub: path, args }));
    if (kind === "registering")
      place(tree, keys, { register: (id) => note(path + ".register", [id]), unregister: (id) => note(path + ".unregister", [id]) });
  });
  return tree;
}

exports.construct = async function construct() {
  for (const [name, list] of Object.entries(entries)) {
    for (const entry of list) {
      const api = load(name, entry);
      ImplementInterface(api, stubs(entry, api));
    }
  }
  const hooks = await loadHooks();
  const services = JSON.parse(process.env.VERIFY_SERVICES || "[]");
  if (hooks.provide) await hooks.provide(load(Object.keys(entries)[0], "."), services);
};
exports.start = function start() {};
exports.stop = function stop() {};
exports.destroy = function destroy() {};
`;
