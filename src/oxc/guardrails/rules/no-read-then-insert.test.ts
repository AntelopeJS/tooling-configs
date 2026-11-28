import { RuleTester } from "oxlint/plugins-dev";

import { noReadThenInsertRule } from "./no-read-then-insert.ts";

const tester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
});
const error = { messageId: "readThenInsert" };

tester.run("antelopejs/no-read-then-insert", noReadThenInsertRule, {
  valid: [
    {
      name: "fails on a rule that lets any arrow body carry the value: a registered handler runs later",
      code: `app.post("/seed", (req) =>
  Promise.all([model.get(id), limit(() => model.insert(seeds[0]))]),
);`,
    },
    {
      name: "fails on a rule that reports any read: a read on another receiver",
      code: `async function seed(users, orders) {
  await users.get(id);
  await orders.insert(row);
}`,
    },
    {
      name: "fails on a rule that ignores order: the insert comes before the read",
      code: `async function seed(model) {
  await model.insert(row);
  return model.get(id);
}`,
    },
    {
      name: "fails on a rule that matches by file: the insert is in a sibling function of the read",
      code: `function read(model) {
  return model.get(id);
}
function write(model) {
  return model.insert(row);
}`,
    },
    {
      name: "fails on a rule that ignores the conflict option: an upsert cannot lose the race",
      code: `async function save(table, total) {
  const [storedId] = await table.getAll(total.cycleKey, "cycleKey").run();
  await table.insert([{ ...total, _id: storedId }], { conflict: "update" }).run();
}`,
    },
    {
      name: "fails on a rule that ignores helpers: the insert is handed to a helper that also takes the table",
      code: `async function provision(roleModel, tenantId) {
  const existing = new Set((await roleModel.getAll()).map((role) => role._id));
  for (const role of missing(existing)) {
    await insertRowOnce(roleModel, roleId(tenantId, role), () =>
      roleModel.insert(toRow(tenantId, role)),
    );
  }
}`,
    },
    {
      name: "fails on a rule that reads only identifier keys: a quoted conflict key is an upsert",
      code: `async function seed(table) {
  if (await table.get(id).run()) return;
  await table.insert(row, { "conflict": "update" }).run();
}`,
    },
    {
      name: "fails on a rule that matches receivers by text alone: a parameter shadows the table",
      code: `async function seed(model) {
  if (await model.get(id)) return;
  await Promise.all(tables.map((model) => model.insert(row)));
}`,
    },
    {
      name: "fails on a rule that lifts every callback: a GET handler's read does not decide a POST handler's insert",
      code: `function routes(app, db) {
  app.get("/items", async () => db.items.getAll());
  app.post("/items", async (row) => db.items.insert(row));
}`,
    },
    {
      name: "fails on a rule that matches nested functions: a setup read and an insert in a later handler",
      code: `async function setup(model) {
  const initial = await model.getAll();
  async function add(row) {
    await model.insert(row);
  }
  return { initial, add };
}`,
    },
    {
      name: "fails on a rule that lifts callbacks whose result is stored: two wrapped route handlers",
      code: `export const GET = withAuth(async () => users.getAll());
export const POST = withAuth(async (req) => users.insert(req.body));`,
    },
    {
      name: "fails on a rule that matches any member of the read receiver: this.get, then this.audit.insert",
      code: `class Service {
  async start(row) {
    const config = await this.get("config");
    await this.audit.insert({ config, row });
  }
}`,
    },
    {
      name: "fails on a rule that reads only the method name: a Map get beside another receiver's insert",
      code: `function seed(cache, store) {
  const hit = cache.get(key);
  if (!hit) store.insert(row);
}`,
    },
    {
      name: "fails on a rule that compares only the root object: one table is read and another table of the same db is inserted",
      code: `async function seed(db) {
  await db.table("a").count();
  await db.table("b").insert(row);
}`,
    },
  ],
  invalid: [
    {
      name: "fails on a rule that stops at an arrow body: p-limit wraps the insert inside a map",
      code: `async function seed(model, seeds) {
  if ((await model.getAll()).length > 0) return;
  await Promise.all(seeds.map((seed) => limit(() => model.insert(seed))));
}`,
      errors: [error],
    },
    {
      name: "fails on a rule that stops at optional chaining: the queue call is awaited through ?.",
      code: `async function seed(model, queue) {
  if (await model.get(id)) return;
  await queue.add?.(() => model.insert(row));
}`,
      errors: [error],
    },
    {
      name: "fails on a rule that lifts only directly awaited calls: the retried read sits in Promise.all",
      code: `async function seed(model, other) {
  const [rows] = await Promise.all([withRetry(() => model.getAll()), other.getAll()]);
  if (rows.length === 0) await model.insert(row);
}`,
      errors: [error],
    },
    {
      name: "fails on a rule that lifts only directly awaited calls: the retried read is chained with then",
      code: `function seed(model) {
  return withRetry(() => model.getAll()).then(async (rows) => {
    if (rows.length === 0) await model.insert(row);
  });
}`,
      errors: [error],
    },
    {
      name: "fails on a rule that applies the shadow exemption to the read's own callback: db is the read's table too",
      code: `async function seed(withDatabase, row) {
  await withDatabase(async (db) => {
    const found = await db.collection("settings").findOne({ _id: id });
    if (!found) await db.collection("settings").insertOne(row);
  });
}`,
      errors: [error],
    },
    {
      name: "fails on a rule that applies the helper exemption to the read's own callback: both run inside withRetry",
      code: `async function seed(model, row) {
  await withRetry(model, async () => {
    if (!(await model.get(id))) await model.insert(row);
  });
}`,
      errors: [error],
    },
    {
      name: "fails on a rule that skips every conflict option: conflict error is a plain insert",
      code: `async function seed(table) {
  if (await table.get(id).run()) return;
  await table.insert(row, { conflict: "error" }).run();
}`,
      errors: [error],
    },
    {
      name: "fails on a rule that takes any callback for a helper: a map over rows does not own the insert",
      code: `async function seed(model, rows) {
  if ((await model.count()) > 0) return;
  await Promise.all(rows.map((row) => model.insert(row)));
}`,
      errors: [error],
    },
    {
      name: "fails on a rule that counts a read only in its own function: the read is in a retry callback",
      code: `async function seed(model) {
  const rows = await withRetry(() => model.getAll());
  if (rows.length === 0) await model.insert(row);
}`,
      errors: [error],
    },
    {
      name: "fails on a rule that counts a read only in its own function: each id is read in a map callback",
      code: `async function seed(model, ids) {
  const found = await Promise.all(ids.map((id) => model.find(id)));
  for (const [index, row] of found.entries())
    if (!row) await model.insert({ _id: ids[index] });
}`,
      errors: [error],
    },
    {
      name: "fails on a rule that needs the exact receiver: the insert goes through a member of the read one",
      code: `async function seed(model) {
  if (await model.getBy("key", key)) return;
  await model.table.insert({ key });
}`,
      errors: [error],
    },
    {
      name: "fails on a rule that takes any call with a callback for a helper: the other argument is not the table",
      code: `async function seed(model) {
  if (await model.get(id)) return;
  await withRetry(3, () => model.insert(row));
}`,
      errors: [error],
    },
    {
      name: "fails on a rule that reads any conflict key: a computed key is not the conflict option",
      code: `async function seed(table) {
  if (await table.get(id).run()) return;
  await table.insert(row, { [conflict]: "update" }).run();
}`,
      errors: [error],
    },
    {
      name: "fails on a rule that skips object literals: the row is written inline",
      code: `async function seed(model) {
  if (await model.get("id")) return;
  await model.insert({ _id: "id", name: "x" });
}`,
      errors: [error],
    },
    {
      name: "fails on a rule that reads conflict anywhere: it is a field of the row, not an option",
      code: `async function seed(model) {
  if (await model.get(id)) return;
  await model.insert({ _id: id, conflict: "pending" });
}`,
      errors: [error],
    },
    {
      name: "fails on a rule that lifts only awaited callbacks: a bare forEach still runs inline",
      code: `async function seed(model, rows) {
  if ((await model.count()) > 0) return;
  rows.forEach((row) => model.insert(row));
}`,
      errors: [error],
    },
    {
      name: "fails on a rule that takes any options object for an upsert: returnChanges is not conflict",
      code: `async function seed(table) {
  if (await table.get(id).run()) return;
  await table.insert(row, { returnChanges: true }).run();
}`,
      errors: [error],
    },
    {
      name: "fails on a rule that lifts only awaited calls: a bare then callback still runs inline",
      code: `function seed(model) {
  model.getAll().then((rows) => {
    if (rows.length === 0) model.insert(row);
  });
}`,
      errors: [error],
    },
    {
      name: "fails on a rule that matches only the same call text: a filtered count then an insert",
      code: `async function seed(table) {
  if ((await table.filter(query).count()) > 0) return;
  await table.insert(row);
}`,
      errors: [error],
    },
    {
      name: "fails on a rule that skips member receivers: this.items",
      code: `class Seeder {
  async run() {
    if ((await this.items.count()) > 0) return;
    await this.items.insertMany(rows);
  }
}`,
      errors: [error],
    },
    {
      name: "fails on a rule that sees only functions: a read and an insert at the top level",
      code: `const existing = await model.findOne(query);
if (!existing) await model.insertOne(row);`,
      errors: [error],
    },
  ],
});

const keyed = (key: string) => ({
  message: `Insert keyed on _id: ${key} races any concurrent writer of the same key: catch the duplicate and read the row back, or upsert with { conflict: "update" }.`,
});

tester.run("antelopejs/no-read-then-insert", noReadThenInsertRule, {
  valid: [
    {
      name: "fails on a rule that skips no conflict option: an upsert keyed on tenantId cannot lose",
      code: `async function seed(model, tenantId) {
  await model.insert({ _id: tenantId }, { conflict: "update" });
}`,
    },
    {
      name: "fails on a rule that ignores the catch: a duplicate is caught and read back",
      code: `async function seed(model, tenantId) {
  try {
    await model.insert({ _id: tenantId });
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    return model.get(tenantId);
  }
}`,
    },
    {
      name: "fails on a rule that keys on any _id: a fresh randomUUID cannot collide",
      code: `import { randomUUID } from "node:crypto";
async function begin(model) {
  const tenantId = randomUUID();
  await model.insert({ _id: tenantId });
}`,
    },
    {
      name: "fails on a rule that keys on any _id: crypto.randomUUID is fresh too",
      code: `async function begin(model) {
  const id = crypto.randomUUID();
  await model.insert([{ _id: id }]);
}`,
    },
    {
      name: "fails on a rule that reads call keys: the key comes from a call",
      code: `async function seed(model, tenantId) {
  await model.insert({ _id: roleId(tenantId, "owner") });
}`,
    },
    {
      name: "fails on a rule that reads any row: a row built elsewhere carries no visible key",
      code: `async function seed(model, row) {
  await model.insert(row);
}`,
    },
    {
      name: "fails on a rule that reads string keys: a literal _id is not a natural key from a caller",
      code: `async function seed(model) {
  await model.insert({ _id: "settings" });
}`,
    },
    {
      name: "fails on a rule that reads computed keys: [_id] names whatever _id holds",
      code: `async function seed(model, _id, tenantId) {
  await model.insert({ [_id]: tenantId });
}`,
    },
    {
      name: "fails on a rule that reads any key: _id nested in another field",
      code: `async function seed(model, tenantId) {
  await model.insert({ owner: { _id: tenantId } });
}`,
    },
  ],
  invalid: [
    {
      name: "fails on a rule that needs a read: a first-row insert keyed on tenantId",
      code: `async function createTenant(model, tenantId) {
  await model.insert({ _id: tenantId, createdAt: new Date() });
}`,
      errors: [keyed("tenantId")],
    },
    {
      name: "fails on a rule that skips arrays: the keyed row is in an array",
      code: `async function createTenant(model, input) {
  await GetModel(TenantModel).insert([{ _id: input.tenantId, name: input.name }]);
}`,
      errors: [keyed("input.tenantId")],
    },
    {
      name: "fails on a rule that skips member keys: a webhook keys on creditNote.id",
      code: `async function store(model, creditNote) {
  await model.insert({ _id: creditNote.id, amount: creditNote.amount });
}`,
      errors: [keyed("creditNote.id")],
    },
    {
      name: "fails on a rule that takes any catch: a catch that rethrows every error",
      code: `async function seed(model, tenantId) {
  try {
    await model.insert({ _id: tenantId });
  } catch (error) {
    log(error);
    throw error;
  }
}`,
      errors: [keyed("tenantId")],
    },
    {
      name: "fails on a rule that takes a catch in a caller: the try is in another function",
      code: `async function insertTenant(model, tenantId) {
  await model.insert({ _id: tenantId });
}
async function seed(model, tenantId) {
  try {
    await insertTenant(model, tenantId);
  } catch {
    return;
  }
}`,
      errors: [keyed("tenantId")],
    },
    {
      name: "fails on a rule that exempts every name: a reassigned randomUUID binding",
      code: `async function seed(model, given) {
  let id = randomUUID();
  if (given) id = given;
  await model.insert({ _id: id });
}`,
      errors: [keyed("id")],
    },
    {
      name: "fails on a rule that takes conflict error for an upsert",
      code: `async function seed(table, tenantId) {
  await table.insert({ _id: tenantId }, { conflict: "error" }).run();
}`,
      errors: [keyed("tenantId")],
    },
    {
      name: "fails on a rule that reads only plain members: the key sits under ?., ! and as",
      code: `async function seed(model, input, t) {
  await model.insert({ _id: input?.tenantId });
  await model.insert({ _id: input.tenantId! });
  await model.insert({ _id: t as string });
}`,
      errors: [keyed("input?.tenantId"), keyed("input.tenantId"), keyed("t")],
    },
    {
      name: "fails on a rule that reads only the first row: the keyed row is the second",
      code: `async function seed(model, tenantId) {
  await model.insert([{ _id: "settings" }, { _id: tenantId }]);
}`,
      errors: [keyed("tenantId")],
    },
    {
      name: "fails on a rule that reads only identifier keys: a quoted _id key",
      code: `async function seed(model, tenantId) {
  await model.insert({ "_id": tenantId });
}`,
      errors: [keyed("tenantId")],
    },
    {
      name: "fails on a rule that skips shorthand properties: { _id }",
      code: `async function seed(model, _id) {
  await model.insert({ _id });
}`,
      errors: [keyed("_id")],
    },
    {
      name: "fails on a rule that matches any name ending in randomUUID: myrandomUUID is not fresh",
      code: `async function seed(model) {
  const id = myrandomUUID();
  await model.insert({ _id: id });
}`,
      errors: [keyed("id")],
    },
    {
      name: "fails on a rule that reports one insert twice: a read then a keyed insert reports the read",
      code: `async function seed(model, tenantId) {
  if (await model.get(tenantId)) return;
  await model.insert({ _id: tenantId });
}`,
      errors: [{ messageId: "readThenInsert" }],
    },
  ],
});
