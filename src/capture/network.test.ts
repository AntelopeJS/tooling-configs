import assert from "node:assert/strict";
import test from "node:test";

import { NetworkLog } from "./network.ts";

test("a fetch counts until it ends", () => {
  const log = new NetworkLog<object>();
  const rows = {};
  log.start(rows, "/api/rows", "fetch");
  assert.deepEqual(log.pendingRequests(), ["/api/rows"]);
  log.end(rows);
  assert.deepEqual(log.pendingRequests(), []);
});

test("EventSource and WebSocket requests never count", () => {
  const log = new NetworkLog<object>();
  log.start({}, "/events", "eventsource");
  log.start({}, "/socket", "websocket");
  assert.deepEqual(log.pendingRequests(), []);
});

test("a fetch that answers an event stream stops counting once its headers arrive", () => {
  const log = new NetworkLog<object>();
  const stream = {};
  log.start(stream, "/api/realtime/connection", "fetch");
  log.respond(stream, "text/event-stream; charset=utf-8");
  assert.deepEqual(log.pendingRequests(), []);
});

test("a fetch that answers JSON still counts once its headers arrive", () => {
  const log = new NetworkLog<object>();
  const rows = {};
  log.start(rows, "/api/rows", "fetch");
  log.respond(rows, "application/json");
  assert.deepEqual(log.pendingRequests(), ["/api/rows"]);
});
