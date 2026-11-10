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
  ],
});
