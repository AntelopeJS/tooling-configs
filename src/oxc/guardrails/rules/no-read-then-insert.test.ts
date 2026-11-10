import { RuleTester } from "oxlint/plugins-dev";

import { noReadThenInsertRule } from "./no-read-then-insert.ts";

const tester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
});
const error = { messageId: "readThenInsert" };

tester.run("antelopejs/no-read-then-insert", noReadThenInsertRule, {
  valid: [
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
      name: "fails on a rule that rejects .catch: a read-back in the callback guards the insert",
      code: `async function seed(model) {
  if (await model.get(id)) return;
  await model.insert(row).catch(async (e) => {
    if (!(await model.get(id))) throw e;
  });
}`,
    },
    {
      name: "fails on a rule that needs a read-back: a duplicate-key check guards the insert",
      code: `async function seed(model) {
  if (await model.get(id)) return;
  try {
    await model.insert(row);
  } catch (e) {
    if (!isDuplicateKeyError(e)) throw e;
  }
}`,
    },
    {
      name: "fails on a rule that needs a call: an instanceof duplicate check guards the insert",
      code: `async function seed(model) {
  if (await model.get(id)) return;
  try {
    await model.insert(row);
  } catch (e) {
    if (!(e instanceof DuplicateKeyError)) throw e;
  }
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
      name: "fails on a rule that needs a read-back: a catch that rethrows nothing lets the loser carry on",
      code: `async function acquire(table, lockKey) {
  if ((await table.getAll(lockKey).count()) > 0) return false;
  try {
    await table.insert({ _id: lockKey }).run();
    return true;
  } catch {
    return false;
  }
}`,
    },
    {
      name: "fails on a rule that needs a read-back: a .catch callback that swallows the error",
      code: `async function seed(model) {
  if (await model.get(id)) return;
  await model.insert(row).catch(() => undefined);
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
      name: "fails on a rule that needs a read-back: the catch checks the Mongo duplicate code",
      code: `async function seed(model) {
  if (await model.get(id)) return;
  try {
    await model.insert(row);
  } catch (error) {
    if (error.code === 11000) return;
    throw error;
  }
}`,
    },
    {
      name: "fails on a rule that needs the word duplicate: the catch calls a unique-violation predicate",
      code: `async function seed(model) {
  if (await model.get(id)) return;
  try {
    await model.insert(row);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
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
      name: "fails on a rule that reads only identifiers: the catch tests the message for a duplicate key",
      code: `async function seed(model) {
  if (await model.get(id)) return;
  try {
    await model.insert(row);
  } catch (error) {
    if (!String(error).includes("duplicate key")) throw error;
  }
}`,
    },
    {
      name: "fails on a rule that recognises .catch only on the insert call: a rethinkdb .run().catch swallows",
      code: `async function seed(table) {
  if (await table.get(id).run()) return;
  await table.insert({ _id: id }).run().catch(() => undefined);
}`,
    },
    {
      name: "fails on a rule that inspects only inline handlers: a named duplicate handler tolerates the loss",
      code: `async function seed(model) {
  if (await model.get(id)) return;
  await model.insert(row).catch(ignoreDuplicateKey);
}`,
    },
    {
      name: "fails on a rule that reads only if conditions: a switch case returns on the duplicate code",
      code: `async function seed(model) {
  if (await model.findOne({ _id: id })) return;
  try {
    await model.insertOne(row);
  } catch (error) {
    switch (error.code) {
      case 11000:
        return;
      default:
        throw error;
    }
  }
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
      name: "fails on a rule that needs the read inside the condition: the catch reads into a variable, then tests it",
      code: `async function reserve(model, id) {
  let current = await model.get(id);
  if (!current) {
    try {
      await model.insert({ _id: id });
    } catch (error) {
      current = await model.get(id);
      if (!current) throw error;
    }
  }
  return current;
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
      name: "fails on a rule that accepts any throwing catch: it rethrows on a condition that never reads back",
      code: `async function seed(model) {
  if (await model.get(id)) return;
  try {
    await model.insert(row);
  } catch (error) {
    if (!isTransient(error)) throw error;
  }
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
      name: "fails on a rule that guards every insert under a try: this one is in the catch",
      code: `async function seed(model) {
  if (await model.get(id)) return;
  try {
    await load();
  } catch {
    await model.insert(row);
  }
}`,
      errors: [error],
    },
    {
      name: "fails on a rule that takes any duplicate text: the catch throws a new error that says duplicate",
      code: `async function seed(model) {
  if (await model.get(id)) return;
  try {
    await model.insert(row);
  } catch {
    throw new Error("duplicate");
  }
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
      name: "fails on a rule that takes any read in the catch: it only logs a count and rethrows",
      code: `async function seed(model) {
  if (await model.get(id)) return;
  try {
    await model.insert(row);
  } catch (error) {
    log("insert failed", await model.count());
    throw error;
  }
}`,
      errors: [error],
    },
    {
      name: "fails on a rule that takes any duplicate name in the file: the catch rethrows unconditionally",
      code: `import { isDuplicateKeyError } from "db";
async function seed(model) {
  if (await model.get(id)) return;
  try {
    await model.insert(row);
  } catch (error) {
    throw new DuplicateSettingsError(String(error));
  }
}`,
      errors: [error],
    },
    {
      name: "fails on a rule that sees only throw statements: the catch returns a rejected promise",
      code: `async function seed(model) {
  if (await model.get(id)) return;
  try {
    await model.insert(row);
  } catch (error) {
    return Promise.reject(error);
  }
}`,
      errors: [error],
    },
    {
      name: "fails on a rule that trusts any named .catch handler",
      code: `async function seed(model) {
  if (await model.get(id)) return;
  await model.insert(row).catch(fail);
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
      name: "fails on a rule that accepts any catch: the catch rethrows without reading back",
      code: `async function seed(model) {
  if (await model.get(id)) return;
  try {
    await model.insert(row);
  } catch (error) {
    throw error;
  }
}`,
      errors: [error],
    },
    {
      name: "fails on a rule that accepts a read-back of another table in the catch",
      code: `async function seed(model, other) {
  if (await model.get(id)) return;
  try {
    await model.insert(row);
  } catch (error) {
    if (!(await other.get(id))) throw error;
  }
}`,
      errors: [error],
    },
    {
      name: "fails on a rule that looks for the read-back anywhere in the try statement: it sits in the block",
      code: `async function seed(model) {
  if (await model.get(id)) return;
  try {
    await model.insert(row);
    await model.get(id);
  } catch (error) {
    throw error;
  }
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
