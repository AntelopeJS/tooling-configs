import { RuleTester } from "oxlint/plugins-dev";

import { noReadThenInsertRule } from "./no-read-then-insert.ts";

const tester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
});
const called = { messageId: "readThenCalledInsert" };

tester.run("antelopejs/no-read-then-insert", noReadThenInsertRule, {
  valid: [
    {
      name: "fails on a rule that reports any later call: no condition reads the result",
      code: `async function sync(model, rows) {
  await model.getAll();
  await addRows(model, rows);
}
async function addRows(model, rows) {
  await model.insert(rows);
}`,
    },
    {
      name: "fails on a rule that ignores the callee's catch: the helper reads the row back",
      code: `async function seed(model) {
  if (await model.get(id)) return;
  await add(model);
}
async function add(model) {
  try {
    await model.insert(row);
  } catch (error) {
    if (!(await model.get(id))) throw error;
  }
}`,
    },
    {
      name: "fails on a rule that ignores the call site's catch: the caller tolerates a duplicate",
      code: `async function seed(model) {
  if (await model.get(id)) return;
  try {
    await add(model);
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
  }
}
async function add(model) {
  await model.insert(row);
}`,
    },
    {
      name: "fails on a rule that follows calls into upserts: the helper writes with conflict update",
      code: `async function seed(table) {
  if (await table.get(id).run()) return;
  await save(table);
}
async function save(table) {
  await table.insert(row, { conflict: "update" }).run();
}`,
    },
    {
      name: "fails on a rule that follows calls a later handler makes: the route registered after the read runs on its own",
      code: `async function setup(app, model) {
  if (await model.count()) return;
  app.post("/rows", async (req) => add(model, req.body));
}
async function add(model, row) {
  await model.insert(row);
}`,
    },
    {
      name: "fails on a rule that resolves calls file-wide: the only add that inserts is local to another function",
      code: `async function seed(model) {
  if (await model.get(id)) return;
  await add(model);
}
function scope1() {
  function add(model) {
    return model.count();
  }
  return add;
}
function scope2() {
  function add(model) {
    return model.insert(row);
  }
  return add;
}`,
    },
    {
      name: "fails on a rule that resolves calls by name: a parameter shadows the file's function",
      code: `async function seed(model, add) {
  const record = await model.findByKey(key);
  if (record) return;
  await add(record);
}
async function add(model) {
  await model.insert(row);
}`,
    },
    {
      name: "fails on a rule that takes any get for a table read: a header decides an insert on another table",
      code: `async function handle(req, db) {
  const token = req.headers.get("authorization");
  if (token) return;
  await createAnonymous(db);
}
async function createAnonymous(db) {
  await db.sessions.insert({ anonymous: true });
}`,
    },
  ],
  invalid: [
    {
      name: "fails on a rule that stops at the reading function: the insert is in a function it calls after an early return",
      code: `async function seed(declarations, assets) {
  const record = await declarations.findByKey(key);
  if (record) return record.targetId;
  return createAsset(assets);
}
async function createAsset(assets) {
  const [id] = await assets.insert(row);
  return id;
}`,
      errors: [{ ...called, line: 7 }],
    },
    {
      name: "fails on a rule that follows one call: the insert is two calls away",
      code: `async function seed(model) {
  if (await model.get(id)) return;
  await create(model);
}
async function create(model) {
  await write(model);
}
async function write(model) {
  await model.insert(row);
}`,
      errors: [{ ...called, line: 9 }],
    },
    {
      name: "fails on a rule that follows only function declarations: the helper is an arrow",
      code: `const add = async (model) => {
  await model.insertOne(row);
};
async function seed(model) {
  const found = await model.findOne(query);
  if (!found) await add(model);
}`,
      errors: [called],
    },
    {
      name: "fails on a rule that skips inline callbacks at the call site: the helper runs in a map",
      code: `async function seed(model, rows) {
  const existing = await model.getAll();
  if (existing.length > 0) return;
  await Promise.all(rows.map((row) => add(model, row)));
}
async function add(model, row) {
  await model.insert(row);
}`,
      errors: [called],
    },
    {
      name: "fails on a rule that takes a catch that rethrows at the call site for a recovery",
      code: `async function seed(model) {
  if (await model.get(id)) return;
  await add(model).catch(async (error) => {
    await cleanup();
    throw error;
  });
}
async function add(model) {
  await model.insert(row);
}`,
      errors: [called],
    },
    {
      name: "fails on a rule that recurses without end: two functions call each other",
      code: `async function seed(model) {
  if (await model.get(id)) return;
  await ping(model);
}
async function ping(model) {
  await model.insert(row);
  await pong(model);
}
async function pong(model) {
  await ping(model);
}`,
      errors: [called],
    },
    {
      name: "fails on a rule that knows only the fixed read names: findByKey reads in the same function",
      code: `async function seed(model) {
  if (await model.findByKey(key)) return;
  await model.insert({ key });
}`,
      errors: [{ messageId: "readThenInsert" }],
    },
    {
      name: "fails on a rule that caches a cycle's partial result: an earlier caller guards the same recursion",
      code: `async function a(model, n) {
  await model.insert({ n });
  if (n > 0) await b(model, n - 1);
}
async function b(model, n) {
  await a(model, n);
}
export async function first(declarations, model) {
  if (await declarations.findByKey(key)) return;
  try {
    await a(model, 1);
  } catch {}
}
export async function second(declarations, model) {
  if (await declarations.findByKey(key)) return;
  await b(model, 1);
}`,
      errors: [called],
    },
    {
      name: "fails on a rule that propagates reach in one pass: the insert is three calls away, declared top-down",
      code: `async function seed(model) {
  if (await model.get(id)) return;
  await first(model);
}
async function first(model) {
  await second(model);
}
async function second(model) {
  await third(model);
}
async function third(model) {
  await model.insert(row);
}`,
      errors: [called],
    },
    {
      name: "fails on a rule that skips overloaded functions: the implementation inserts",
      code: `function add(model: Model): Promise<void>;
function add(model: Model, row: Row): Promise<void>;
async function add(model: Model, row?: Row): Promise<void> {
  await model.insert(row ?? {});
}
async function seed(model: Model) {
  if (await model.get(id)) return;
  await add(model);
}`,
      errors: [called],
    },
    {
      name: "fails on a rule that stops at query builders: limit then run before the await",
      code: `async function seed(table) {
  const rows = await table.getAll(key, { index: "key" }).limit(1).run();
  if (rows.length > 0) return;
  await add(table);
}
async function add(table) {
  await table.insert(row).run();
}`,
      errors: [called],
    },
  ],
});
