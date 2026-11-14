import { RuleTester } from "oxlint/plugins-dev";

import { noReadThenInsertRule } from "./no-read-then-insert.ts";

const tester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
});
const called = { messageId: "readThenCalledInsert" };

tester.run("antelopejs/no-read-then-insert", noReadThenInsertRule, {
  valid: [
    {
      name: "fails on a rule that ignores the test's polarity: the call runs only when the read found a row",
      code: `async function order(users, orders, id) {
  const user = await users.get(id);
  if (!user) throw new Error("no user");
  await createOrder(orders, user);
}
async function createOrder(orders, user) {
  await orders.insert({ user: user._id });
}`,
    },
    {
      name: "fails on a rule that ignores the branch: the call sits in the branch taken when the row exists",
      code: `async function order(users, orders, id) {
  const user = await users.get(id);
  if (user) await createOrder(orders, user);
}
async function createOrder(orders, user) {
  await orders.insert({ user: user._id });
}`,
    },
    {
      name: "fails on a rule that takes any earlier if: its found branch does not leave the function",
      code: `async function seed(model) {
  const record = await model.findByKey(key);
  if (record) log(record);
  await add(model);
}
async function add(model) {
  await model.insert(row);
}`,
    },
    {
      name: "fails on a rule that takes any test that names the result: a field of the row is not the row",
      code: `async function seed(model) {
  const record = await model.findByKey(key);
  if (record.done) return;
  await add(model);
}
async function add(model) {
  await model.insert(row);
}`,
    },
    {
      name: "fails on a rule that takes any break for an exit: it leaves a loop the call follows",
      code: `async function seed(model, rows) {
  const existing = await model.findByKey(key);
  for (const row of rows) {
    if (existing) break;
    log(row);
  }
  await add(model);
}
async function add(model) {
  await model.insert(row);
}`,
    },
    {
      name: "fails on a rule that takes a callback's return for an exit: it leaves only the forEach callback",
      code: `async function seed(model, rows) {
  const existing = await model.findByKey(key);
  rows.forEach((row) => {
    if (existing) return;
    log(row);
  });
  await add(model);
}
async function add(model) {
  await model.insert(row);
}`,
    },
    {
      name: "fails on a rule that takes an exit in a sibling branch: the call sits in the other branch",
      code: `async function seed(model, mode) {
  const existing = await model.findByKey(key);
  if (mode === "check") {
    if (existing) return;
    log("missing");
  } else {
    await add(model);
  }
}
async function add(model) {
  await model.insert(row);
}`,
    },
    {
      name: "fails on a rule that matches the result by name: a loop variable shadows it",
      code: `async function seed(model, items) {
  const record = await model.findByKey(key);
  use(record);
  for (const item of items) {
    const record = item.parent;
    if (record) continue;
    await add(model, item);
  }
}
async function add(model, item) {
  await model.insert(item);
}`,
    },
    {
      name: "fails on a rule that climbs any else if: an earlier arm falls through to the call",
      code: `async function seed(model, mode) {
  const existing = await model.findByKey(key);
  if (mode === "force") log("forcing");
  else if (existing) return;
  await add(model);
}
async function add(model) {
  await model.insert(row);
}`,
    },
    {
      name: "fails on a rule that climbs a braceless nested if: the outer test can skip the exit",
      code: `async function seed(model, strict) {
  const existing = await model.findByKey(key);
  if (strict) if (existing) return;
  await add(model);
}
async function add(model) {
  await model.insert(row);
}`,
    },
    {
      name: "fails on a rule that binds a field of the row: enabled is not the row",
      code: `async function seed(model) {
  const enabled = (await model.findByKey(key))?.enabled;
  if (enabled) return;
  await add(model);
}
async function add(model) {
  await model.insert(row);
}`,
    },
    {
      name: "fails on a rule that binds a method of the row: the name it derives is not the row",
      code: `async function seed(model) {
  const name = (await model.findByKey(key)).getName();
  if (name) return;
  await add(model);
}
async function add(model) {
  await model.insert(row);
}`,
    },
  ],
  invalid: [
    {
      name: "fails on a rule that reads only truthiness: a count compared to zero",
      code: `async function seed(model) {
  if ((await model.count()) === 0) await fill(model);
}
function fill(model) {
  return model.insertMany(rows);
}`,
      errors: [called],
    },
    {
      name: "fails on a rule that reads only if statements: a nullish fallback creates the row",
      code: `async function ensure(model) {
  const existing = await model.getByKey(key);
  return existing ?? (await create(model));
}
async function create(model) {
  return model.insert(row);
}`,
      errors: [called],
    },
    {
      name: "fails on a rule that counts only return as an exit: the loop continues past a found row",
      code: `async function seed(model, keys) {
  for (const key of keys) {
    const row = await model.findByKey(key);
    if (row) continue;
    await add(model, key);
  }
}
async function add(model, key) {
  await model.insert({ key });
}`,
      errors: [called],
    },
    {
      name: "fails on a rule that gives up on a combined test: the result is checked with another flag",
      code: `async function seed(model, enabled) {
  const record = await model.findByKey(key);
  if (!record && enabled) await add(model);
}
async function add(model) {
  await model.insert(row);
}`,
      errors: [called],
    },
    {
      name: "fails on a rule that gives up on a combined exit: found or dry run returns",
      code: `async function seed(model, dryRun) {
  const record = await model.findByKey(key);
  if (record || dryRun) return;
  await add(model);
}
async function add(model) {
  await model.insert(row);
}`,
      errors: [called],
    },
    {
      name: "fails on a rule that binds only plain names: the first row is destructured",
      code: `async function seed(model) {
  const [record] = await model.getAll(key, { index: "key" });
  if (record) return;
  await add(model);
}
async function add(model) {
  await model.insert(row);
}`,
      errors: [called],
    },
    {
      name: "fails on a rule that stops at an else if: every earlier arm returns too",
      code: `async function seed(model, off) {
  const existing = await model.findByKey(key);
  if (off) return;
  else if (existing) return;
  await add(model);
}
async function add(model) {
  await model.insert(row);
}`,
      errors: [called],
    },
    {
      name: "fails on a rule that binds only the row: a count read through length",
      code: `async function seed(model) {
  const size = (await model.getAll()).length;
  if (size > 0) return;
  await add(model);
}
async function add(model) {
  await model.insert(row);
}`,
      errors: [called],
    },
    {
      name: "fails on a rule that drops an index on the settled rows: the first row decides",
      code: `async function seed(model) {
  const first = (await model.getAll())[0];
  if (first) return;
  await add(model);
}
async function add(model) {
  await model.insert(row);
}`,
      errors: [called],
    },
  ],
});
