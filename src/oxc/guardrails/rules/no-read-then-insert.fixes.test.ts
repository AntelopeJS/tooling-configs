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
      name: "dms-media@06994c8:packages/dms-media/src/declared/assets.ts",
      code: `async function insertAsset(
  { models, declaration, folder }: AssetTarget,
  id: string,
  file: PreparedFile,
  storageKey: string,
): Promise<boolean> {
  try {
    await models.assetModel.insert({
      _id: id,
      folderId: folder._id,
      name: declaration.name,
      storageKey,
    });
    return true;
  } catch (error) {
    if (!IsDuplicateKeyError(error)) throw error;
    return false;
  }
}

async function createAsset(
  target: AssetTarget,
  file: PreparedFile,
): Promise<MediaDeclarationResult> {
  const { models, declaration } = target;
  const id = declaredId(models.tenantId, "asset", declaration.key);
  const storageKey = await writeFile(target, file);
  const discardFile = () =>
    DeleteFile(storageKey, getMediaConfig().storage).catch(() => undefined);
  const inserted = await insertAsset(target, id, file, storageKey).catch(
    async (error: unknown) => {
      await discardFile();
      throw error;
    },
  );
  const asset = await models.assetModel.get(id);
  if (!inserted || !asset) await discardFile();
  if (!asset)
    throw new MediaDeclarationError(
      "asset",
      declaration.key,
      "the file could not be created",
    );
  if (!inserted) return { status: "kept", id };
  return { status: "created", id };
}

async function applyAssetDeclaration(
  declaration: DeclaredAssetInput,
): Promise<MediaDeclarationResult> {
  const models = declaredModels(declaration.tenantId);
  const record = await models.declarationModel.findByKey(
    "asset",
    declaration.key,
  );
  if (record) return { status: "kept", id: record.targetId };
  const fail: Fail = (reason) => {
    throw new MediaDeclarationError("asset", declaration.key, reason);
  };
  const folder = await findTargetFolder(models, declaration, fail);
  const target: AssetTarget = {
    models,
    declaration,
    folder,
    fieldBinding: await fieldBindingOf(models, folder),
  };
  const file = await prepareFile(target, await readSource(declaration, fail));
  const result = await createAsset(target, file);
  await rememberDeclaration(models, "asset", declaration.key, result.id);
  return result;
}`,
    },
  ],
  invalid: [
    {
      name: "dms-media@5cd00df:packages/dms-media/src/declared/assets.ts:155",
      code: `async function insertAsset(
  { models, declaration, folder }: AssetTarget,
  file: PreparedFile,
  storageKey: string,
): Promise<MediaAsset | undefined> {
  const [assetId] = await models.assetModel.insert({
    folderId: folder._id,
    mediaRevision: randomUUID(),
    json_retiredFiles: "[]",
    name: declaration.name,
    mimetype: file.mimetype,
    size: file.bytes.byteLength,
    storageKey,
    storage: getMediaConfig().storage,
    width: file.image.width,
    height: file.image.height,
    alt: declaration.alt,
    visibility: "inherit",
    createdBy: DECLARED_CONTENT_AUTHOR._id,
  });
  return models.assetModel.get(assetId);
}

async function createAsset(
  target: AssetTarget,
  file: PreparedFile,
): Promise<MediaAsset> {
  const storageKey = await writeFile(target, file);
  const discardFile = () =>
    DeleteFile(storageKey, getMediaConfig().storage).catch(() => undefined);
  const asset = await insertAsset(target, file, storageKey).catch(
    async (error: unknown) => {
      await discardFile();
      throw error;
    },
  );
  if (!asset) {
    await discardFile();
    throw new MediaDeclarationError(
      "asset",
      target.declaration.key,
      "the file could not be created",
    );
  }
  await recordMediaEvent(
    { tenantId: target.models.tenantId, user: DECLARED_CONTENT_AUTHOR },
    {
      kind: "asset.upload",
      targetName: asset.name,
      folderId: asset.folderId,
      assetId: asset._id,
      size: asset.size,
    },
  );
  return asset;
}

async function applyAssetDeclaration(
  declaration: DeclaredAssetInput,
): Promise<MediaDeclarationResult> {
  const models = declaredModels(declaration.tenantId);
  const record = await models.declarationModel.findByKey(
    "asset",
    declaration.key,
  );
  if (record) return { status: "kept", id: record.targetId };
  const fail: Fail = (reason) => {
    throw new MediaDeclarationError("asset", declaration.key, reason);
  };
  const folder = await findTargetFolder(models, declaration, fail);
  const target: AssetTarget = {
    models,
    declaration,
    folder,
    fieldBinding: await fieldBindingOf(models, folder),
  };
  const file = await prepareFile(target, await readSource(declaration, fail));
  const asset = await createAsset(target, file);
  await rememberDeclaration(models, "asset", declaration.key, asset._id);
  return { status: "created", id: asset._id };
}`,
      errors: [{ messageId: "readThenCalledInsert", line: 6 }],
    },
    {
      name: "dms-media@07b7510:packages/dms-media/src/declared/folders.ts:102",
      code: `async function createFolder(
  models: DeclaredModels,
  declaration: DeclaredFolderInput,
  parent: MediaFolder | undefined,
): Promise<MediaFolder> {
  const folders = await models.folderModel.getAll();
  if (hasSiblingNamed(folders, declaration.name, parent?._id))
    throw new MediaDeclarationError(
      "folder",
      declaration.key,
      \`a folder named '\${declaration.name}' already exists there\`,
    );
  const [folderId] = await models.folderModel.insert({
    name: declaration.name,
    parentId: parent?._id,
    path: buildChildPath(parent),
  });
  const folder = await models.folderModel.get(folderId);
  if (!folder)
    throw new MediaDeclarationError(
      "folder",
      declaration.key,
      "the folder could not be created",
    );
  return folder;
}

async function applyFolderDeclaration(
  declaration: DeclaredFolderInput,
): Promise<MediaDeclarationResult> {
  const models = declaredModels(declaration.tenantId);
  const record = await models.declarationModel.findByKey(
    "folder",
    declaration.key,
  );
  if (record) return { status: "kept", id: record.targetId };
  const fail = (reason: string): never => {
    throw new MediaDeclarationError("folder", declaration.key, reason);
  };
  const parent = declaration.parent
    ? await findParentFolder(models, declaration.parent, fail)
    : undefined;
  const folder = await createFolder(models, declaration, parent);
  await rememberDeclaration(models, "folder", declaration.key, folder._id);
  return { status: "created", id: folder._id };
}`,
      errors: [{ messageId: "readThenInsert", line: 13 }],
    },
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
