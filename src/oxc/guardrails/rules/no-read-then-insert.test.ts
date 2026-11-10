import { RuleTester } from "oxlint/plugins-dev";

import { noReadThenInsertRule } from "./no-read-then-insert.ts";

const tester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
});
const error = { messageId: "readThenInsert" };

tester.run("antelopejs/no-read-then-insert", noReadThenInsertRule, {
  valid: [
    {
      name: "dms-api@be2345d:src/services/routes-sync.ts",
      code: `async function insertRoute(
  routesModel: RoutesStore,
  route: ReturnType<typeof computeInserts>[number],
): Promise<void> {
  try {
    await routesModel.insert(route);
  } catch (error) {
    if (!(await routesModel.get(route._id))) throw error;
  }
}

async function runSync(
  routesModel: RoutesStore,
  registeredRoutes: RegisteredRoute[],
  stats: StatisticsSource,
): Promise<void> {
  const [existingRoutes, localModules] = await Promise.all([
    routesModel.getAll(),
    getOwnModuleIds(),
  ]);
  const ownModules = withoutConsole(localModules, registeredRoutes);
  const now = new Date();

  const existingByKey = new Map(
    existingRoutes.map((route) => [
      getRouteKey(route.method, route.uri),
      route,
    ]),
  );
  const registeredByKey = new Map(
    registeredRoutes.map((r) => [getRouteKey(r.method, r.location), r]),
  );

  const idsToDelete = computeDeletes(existingByKey, registeredByKey);
  const routesToInsert = computeInserts(
    registeredByKey,
    existingByKey,
    ownModules,
    now,
  );
  const routesToUpdate = computeUpdates(
    existingByKey,
    registeredByKey,
    ownModules,
  );

  await Promise.all([
    ...idsToDelete.map((id) => routesModel.delete(id)),
    ...routesToInsert.map((r) => insertRoute(routesModel, r)),
    ...routesToUpdate.map((r) => routesModel.update(r)),
  ]);
  await backdateToFirstCall(routesModel, stats);
  syncedSignature = signatureOf(registeredRoutes);
}`,
    },
    {
      name: "dms-saas@433633b:packages/dms-saas/src/operator-billing/billing-settings-store.ts",
      code: `export async function ensureBillingSettingsRow(
  model: BillingSettingsModel = GetModel(BillingSettingsModel),
): Promise<void> {
  if (await model.get(BILLING_SETTINGS_SINGLETON_ID)) return;
  try {
    await model.insert([defaultBillingSettings(new Date())]);
  } catch (error) {
    if (!(await model.get(BILLING_SETTINGS_SINGLETON_ID))) throw error;
  }
}`,
    },
    {
      name: "dms-saas@433633b:packages/dms-saas/src/operator-billing/legal-documents-store.ts",
      code: `export async function ensureLegalDocumentsRow(
  model: LegalDocumentsModel,
): Promise<void> {
  if (await model.get(LEGAL_DOCUMENTS_SINGLETON_ID)) return;
  try {
    await model.insert([emptyDocuments(new Date())]);
  } catch (error) {
    if (!(await model.get(LEGAL_DOCUMENTS_SINGLETON_ID))) throw error;
  }
}`,
    },
    {
      name: "dms@3e029b0:packages/dms/src/utils/ensure-default-tenant.ts",
      code: `export async function ensureDefaultTenantExists(): Promise<boolean> {
  const tenants = GetModel(TenantModel);
  const existing = await tenants.get(DEFAULT_TENANT_ID);
  if (existing) {
    Logging.Info(\`Default tenant '\${DEFAULT_TENANT_ID}' already exists.\`);
    return false;
  }

  try {
    await tenants.insert(buildDefaultTenant());
  } catch (error) {
    if (!(await tenants.get(DEFAULT_TENANT_ID))) throw error;
    Logging.Info(\`Default tenant '\${DEFAULT_TENANT_ID}' already exists.\`);
    return false;
  }
  Logging.Info(\`Default tenant '\${DEFAULT_TENANT_ID}' created.\`);
  return true;
}`,
    },
    {
      name: "interface-database-decorators@cac002a:src/database.ts",
      code: `async function insertFixtureData(
  schema: Schema<any>,
  tableName: string,
  tableClass: Class<Table>,
  generator: DatumStaticMetadata["generator"],
): Promise<void> {
  if (!generator) {
    return;
  }
  const count = await schema.instance().table(tableName).count();
  if (count > 0) {
    return;
  }
  const fixtureData = await generator(tableClass);
  const rows = toFixtureRows(fixtureData, tableClass).map((row, position) =>
    withStableId(row, tableName, position),
  );
  if (rows.length === 0) {
    return;
  }
  const payload: any = rows.length === 1 ? rows[0] : rows;
  const table = schema.instance().table(tableName);
  try {
    await table.insert(payload);
  } catch (error) {
    if ((await table.count()) === 0) throw error;
  }
}`,
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
      name: "dms-api@3e6b6a6:src/services/routes-sync.ts:188",
      code: `async function runSync(
  routesModel: RoutesStore,
  registeredRoutes: RegisteredRoute[],
  stats: StatisticsSource,
): Promise<void> {
  const [existingRoutes, localModules] = await Promise.all([
    routesModel.getAll(),
    getOwnModuleIds(),
  ]);
  const ownModules = withoutConsole(localModules, registeredRoutes);
  const now = new Date();

  const existingByKey = new Map(
    existingRoutes.map((route) => [
      getRouteKey(route.method, route.uri),
      route,
    ]),
  );
  const registeredByKey = new Map(
    registeredRoutes.map((r) => [getRouteKey(r.method, r.location), r]),
  );

  const idsToDelete = computeDeletes(existingByKey, registeredByKey);
  const routesToInsert = computeInserts(
    registeredByKey,
    existingByKey,
    ownModules,
    now,
  );
  const routesToUpdate = computeUpdates(
    existingByKey,
    registeredByKey,
    ownModules,
  );

  await Promise.all([
    ...idsToDelete.map((id) => routesModel.delete(id)),
    ...routesToInsert.map((r) => routesModel.insert(r)),
    ...routesToUpdate.map((r) => routesModel.update(r)),
  ]);
  await backdateToFirstCall(routesModel, stats);
  syncedSignature = signatureOf(registeredRoutes);
}`,
      errors: [error],
    },
    {
      name: "dms-saas@3223e8a:packages/dms-saas/src/operator-billing/billing-settings-store.ts:66",
      code: `export async function ensureBillingSettingsRow(
  model: BillingSettingsModel = GetModel(BillingSettingsModel),
): Promise<void> {
  if (await model.get(BILLING_SETTINGS_SINGLETON_ID)) return;
  await model.insert([defaultBillingSettings(new Date())]);
}`,
      errors: [error],
    },
    {
      name: "dms-saas@3223e8a:packages/dms-saas/src/operator-billing/legal-documents-store.ts:41",
      code: `export async function ensureLegalDocumentsRow(
  model: LegalDocumentsModel,
): Promise<void> {
  const existing = await model.get(LEGAL_DOCUMENTS_SINGLETON_ID);
  if (existing) return;
  await model.insert([emptyDocuments(new Date())]);
}`,
      errors: [error],
    },
    {
      name: "dms@c630e0e:packages/dms/src/utils/ensure-default-tenant.ts:29",
      code: `export async function ensureDefaultTenantExists(): Promise<boolean> {
  const tenants = GetModel(TenantModel);
  const existing = await tenants.get(DEFAULT_TENANT_ID);
  if (existing) {
    Logging.Info(\`Default tenant '\${DEFAULT_TENANT_ID}' already exists.\`);
    return false;
  }

  await tenants.insert(buildDefaultTenant());
  Logging.Info(\`Default tenant '\${DEFAULT_TENANT_ID}' created.\`);
  return true;
}`,
      errors: [error],
    },
    {
      name: "interface-database-decorators@5d14b16:src/database.ts:92",
      code: `async function insertFixtureData(
  schema: Schema<any>,
  tableName: string,
  tableClass: Class<Table>,
  generator: DatumStaticMetadata["generator"],
): Promise<void> {
  if (!generator) {
    return;
  }
  const count = await schema.instance().table(tableName).count();
  if (count > 0) {
    return;
  }
  const fixtureData = await generator(tableClass);
  const rows = toFixtureRows(fixtureData, tableClass);
  if (rows.length === 0) {
    return;
  }
  const payload: any = rows.length === 1 ? rows[0] : rows;
  await schema.instance().table(tableName).insert(payload);
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
