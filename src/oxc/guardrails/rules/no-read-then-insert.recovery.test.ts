import { RuleTester } from "oxlint/plugins-dev";

import { noReadThenInsertRule } from "./no-read-then-insert.ts";

const tester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
});
const error = { messageId: "readThenInsert" };

tester.run("antelopejs/no-read-then-insert", noReadThenInsertRule, {
  valid: [
    {
      name: "fails on a rule that reads only if conditions: a switch case returns on the MySQL duplicate code",
      code: `async function seed(model) {
  if (await model.get(id)) return;
  try {
    await model.insert(row);
  } catch (error) {
    switch (error.code) {
      case "ER_DUP_ENTRY":
        return;
    }
    throw error;
  }
}`,
    },
    {
      name: "fails on a rule that knows only numeric Mongo codes: the message carries E11000",
      code: `async function seed(model) {
  if (await model.get(id)) return;
  try {
    await model.insert(row);
  } catch (error) {
    if (String(error).includes("E11000")) return;
    throw error;
  }
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
      name: "fails on a rule that needs the throw in a branch: the catch returns on the read-back, then rethrows",
      code: `async function seed(model) {
  if (await model.get(id)) return;
  try {
    await model.insert(row);
  } catch (error) {
    const existing = await model.get(id);
    if (existing) return;
    throw error;
  }
}`,
    },
    {
      name: "fails on a rule that skips template literals: the catch tests a duplicate key message",
      code: `async function seed(model) {
  if (await model.get(id)) return;
  try {
    await model.insert(row);
  } catch (error) {
    if (error.message.includes(\`duplicate key\`)) return;
    throw error;
  }
}`,
    },
    {
      name: "fails on a rule that reads only if statements: a ternary rejects anything but the Postgres unique code",
      code: `async function seed(model) {
  if (await model.get(id)) return;
  return model
    .insert(row)
    .catch((error) => (error.code === "23505" ? undefined : Promise.reject(error)));
}`,
    },
    {
      name: "fails on a rule that takes only arrow handlers: a function expression .catch that only warns",
      code: `async function seed(model) {
  if (await model.get(id)) return;
  await model.insert(row).catch(function () {
    console.warn("lost the insert");
  });
}`,
    },
  ],
  invalid: [
    {
      name: "fails on a rule that trusts any duplicate test: the catch only warns on it, then always rethrows",
      code: `async function seed(model) {
  if (await model.get(id)) return;
  try {
    await model.insert(row);
  } catch (error) {
    if (error.code === "23505") console.warn("lost the race");
    throw error;
  }
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
      name: "fails on a rule that takes duplicate text anywhere: both branches rethrow, one with a unique message",
      code: `async function seed(model) {
  if (await model.get(id)) return;
  try {
    await model.insert(row);
  } catch (error) {
    if (error.fatal) throw new Error("unique admin seed failed");
    else throw error;
  }
}`,
      errors: [error],
    },
    {
      name: "fails on a rule that treats .then like .catch: its callback is not a recovery",
      code: `async function seed(model) {
  if (await model.get(id)) return;
  await model.insert(row).then(() => 1);
}`,
      errors: [error],
    },
    {
      name: "fails on a rule with an unanchored Mongo code: 211000 is not 11000",
      code: `async function seed(model) {
  if (await model.get(id)) return;
  try {
    await model.insert(row);
  } catch (error) {
    if (error.status !== 211000) throw error;
  }
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
  ],
});
