import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";

import Ajv2020 from "ajv/dist/2020";
import yaml from "js-yaml";
import { Pool, PoolClient } from "pg";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

type Operation = "fill" | "overwrite" | "export" | "delete";

type CliArgs = {
  instanceId: string;
  marketId: string;
  operation: Operation;
  configRoot: string;
  dbUrl?: string;
  outputPath?: string;
  confirm: boolean;
  force: boolean;
  dryRun: boolean;
  logLevel: "debug" | "info" | "warn";
};

type InputConfig = {
  market?: Record<string, unknown>;
  products?: Record<string, unknown>;
  vendors: Record<string, Record<string, unknown>>;
  warnings: string[];
};

type StoredRow = {
  section: "market" | "products" | "vendor_products";
  record_key: string;
  data: unknown;
};

type Report = {
  ok: boolean;
  operation: Operation;
  instance_id: string;
  market_id: string;
  dry_run: boolean;
  inserted: number;
  updated: number;
  skipped: number;
  deleted: number;
  warnings: string[];
  output_path?: string;
  exported_tables?: string[];
};

const STORAGE_TABLE = "gp_market_runtime_config";
const CHANNEL_ASSIGNMENT_TABLES = [
  "product_sales_channel",
  "publishable_api_key_sales_channel",
  "sales_channel_stock_location",
];

const SCHEMAS = {
  market: "market-runtime-config.v1.schema.json",
  products: "products-catalog.v1.schema.json",
  vendorProducts: "vendor-products-catalog.v1.schema.json",
};

function detectRepoRoot(startDir: string): string {
  let cursor = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(cursor, "_bmad")) || fs.existsSync(path.join(cursor, "specs"))) {
      return cursor;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      return path.resolve(startDir);
    }
    cursor = parent;
  }
}

function resolveDefaultConfigRoot(repoRoot: string): string {
  const candidates = [
    path.join(repoRoot, "GP", "config"),
    path.join(process.cwd(), "GP", "config"),
    path.join(process.cwd(), "config"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0];
}

function parseArgs(repoRoot: string): CliArgs {
  const defaultConfigRoot = resolveDefaultConfigRoot(repoRoot);

  const argv = yargs(hideBin(process.argv))
    .scriptName("gp-config-mcp")
    .option("instance-id", { type: "string", demandOption: true })
    .option("market-id", { type: "string", demandOption: true })
    .option("operation", {
      choices: ["fill", "overwrite", "export", "delete"] as const,
      demandOption: true,
    })
    .option("config-root", { type: "string", default: defaultConfigRoot })
    .option("db-url", { type: "string" })
    .option("output-path", { type: "string" })
    .option("confirm", { type: "boolean", default: false })
    .option("force", { type: "boolean", default: false })
    .option("dry-run", { type: "boolean", default: false })
    .option("log-level", {
      choices: ["debug", "info", "warn"] as const,
      default: "info" as const,
    })
    .strict()
    .parseSync();

  return {
    instanceId: argv["instance-id"],
    marketId: argv["market-id"],
    operation: argv.operation,
    configRoot: path.resolve(argv["config-root"]),
    dbUrl: argv["db-url"],
    outputPath: argv["output-path"],
    confirm: argv.confirm,
    force: argv.force,
    dryRun: argv["dry-run"],
    logLevel: argv["log-level"],
  };
}

function log(args: CliArgs, level: "debug" | "info" | "warn", message: string) {
  const priority: Record<typeof level, number> = { debug: 10, info: 20, warn: 30 };
  if (priority[level] < priority[args.logLevel]) {
    return;
  }
  const stream = level === "warn" ? process.stderr : process.stdout;
  stream.write(`[${level}] ${message}\n`);
}

export function ensureSafeDestructiveOperation(args: CliArgs): void {
  if (!(args.operation === "overwrite" || args.operation === "delete")) {
    return;
  }

  const isProdLike = /(prod|production)$/i.test(args.instanceId);
  const allowProdMutations = process.env.GP_ALLOW_PROD_MUTATIONS === "true";
  if (isProdLike && !allowProdMutations) {
    throw new Error(
      "Destructive operations are blocked for prod/production instances. Set GP_ALLOW_PROD_MUTATIONS=true to override."
    );
  }
}

export function requireConfirmFlags(args: CliArgs): void {
  if (args.operation === "overwrite") {
    if (!(args.confirm || args.force)) {
      throw new Error("Operation overwrite requires --confirm or --force.");
    }
  }

  if (args.operation === "delete") {
    if (!(args.confirm || args.force)) {
      throw new Error("Operation delete requires --confirm or --force.");
    }
  }
}

async function requireInteractiveDeleteConfirmation(args: CliArgs): Promise<void> {
  if (args.operation !== "delete" || args.force) {
    return;
  }

  if (!args.confirm) {
    throw new Error("Operation delete requires --confirm.");
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const entered = await new Promise<string>((resolve) => {
    rl.question(`Type market_id '${args.marketId}' to confirm delete: `, resolve);
  });
  rl.close();

  if ((entered || "").trim() !== args.marketId) {
    throw new Error("Interactive confirmation failed: market_id mismatch.");
  }
}

function readYamlObject(yamlPath: string): Record<string, unknown> {
  const raw = fs.readFileSync(yamlPath, "utf-8");
  const parsed = yaml.load(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid YAML object in ${yamlPath}`);
  }
  return parsed as Record<string, unknown>;
}

function loadJsonSchema(schemaPath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(schemaPath, "utf-8")) as Record<string, unknown>;
}

function validateAgainstSchema(
  ajv: Ajv2020,
  schema: Record<string, unknown>,
  payload: Record<string, unknown>,
  label: string
) {
  const validate = ajv.compile(schema);
  const ok = validate(payload);
  if (!ok) {
    const details = (validate.errors || [])
      .map((e) => `${e.instancePath || "$"} ${e.message || "schema error"}`)
      .join("; ");
    throw new Error(`Schema validation failed for ${label}: ${details}`);
  }
}

function resolvePaths(args: CliArgs) {
  const instanceDir = path.join(args.configRoot, args.instanceId);
  const marketDir = path.join(instanceDir, "markets", args.marketId);
  const instanceYamlPath = path.join(instanceDir, "instance.yaml");
  const marketYamlPath = path.join(marketDir, "market.yaml");
  const productsYamlPath = path.join(marketDir, "products.yaml");
  const vendorsDir = path.join(marketDir, "vendors");
  return { instanceDir, marketDir, instanceYamlPath, marketYamlPath, productsYamlPath, vendorsDir };
}

function assertInstanceAndMarketExist(args: CliArgs, instanceYamlPath: string): void {
  if (!fs.existsSync(instanceYamlPath)) {
    throw new Error(`Missing instance.yaml: ${instanceYamlPath}`);
  }

  const instanceData = readYamlObject(instanceYamlPath);
  const instanceId = instanceData.instance_id;
  if (instanceId !== args.instanceId) {
    throw new Error(`instance.yaml instance_id='${String(instanceId)}' does not match --instance-id='${args.instanceId}'`);
  }

  const markets = Array.isArray(instanceData.markets) ? (instanceData.markets as Array<Record<string, unknown>>) : [];
  const hasMarket = markets.some((m) => m.market_id === args.marketId);
  if (!hasMarket) {
    throw new Error(`market_id='${args.marketId}' not found in ${instanceYamlPath}`);
  }
}

function loadInputConfig(args: CliArgs, repoRoot: string): InputConfig {
  const warnings: string[] = [];
  const paths = resolvePaths(args);
  assertInstanceAndMarketExist(args, paths.instanceYamlPath);

  const schemasDir = path.join(repoRoot, "specs", "contracts", "config", "schemas");
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const marketSchema = loadJsonSchema(path.join(schemasDir, SCHEMAS.market));
  const productsSchema = loadJsonSchema(path.join(schemasDir, SCHEMAS.products));
  const vendorProductsSchema = loadJsonSchema(path.join(schemasDir, SCHEMAS.vendorProducts));

  let market: Record<string, unknown> | undefined;
  let products: Record<string, unknown> | undefined;
  const vendors: Record<string, Record<string, unknown>> = {};

  if (fs.existsSync(paths.marketYamlPath)) {
    market = readYamlObject(paths.marketYamlPath);
    validateAgainstSchema(ajv, marketSchema, market, "market.yaml");
  } else {
    warnings.push(`Missing file: ${paths.marketYamlPath}`);
  }

  if (fs.existsSync(paths.productsYamlPath)) {
    products = readYamlObject(paths.productsYamlPath);
    validateAgainstSchema(ajv, productsSchema, products, "products.yaml");
  } else {
    warnings.push(`Missing file: ${paths.productsYamlPath}`);
  }

  if (fs.existsSync(paths.vendorsDir)) {
    for (const vendorEntry of fs.readdirSync(paths.vendorsDir, { withFileTypes: true })) {
      if (!vendorEntry.isDirectory()) continue;
      const vendorId = vendorEntry.name;
      const vendorProductsPath = path.join(paths.vendorsDir, vendorId, "products.yaml");
      if (!fs.existsSync(vendorProductsPath)) {
        warnings.push(`Missing file: ${vendorProductsPath}`);
        continue;
      }
      const vendorProducts = readYamlObject(vendorProductsPath);
      validateAgainstSchema(ajv, vendorProductsSchema, vendorProducts, `vendors/${vendorId}/products.yaml`);
      vendors[vendorId] = vendorProducts;
    }
  }

  return { market, products, vendors, warnings };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function quoteIdent(identifier: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
    throw new Error(`Invalid SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

async function tableExists(client: PoolClient, tableName: string): Promise<boolean> {
  const result = await client.query(
    `
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = $1
      LIMIT 1
    `,
    [tableName]
  );
  return result.rowCount > 0;
}

async function countRows(client: PoolClient, tableName: string, whereClause: string, params: unknown[]): Promise<number> {
  const result = await client.query(`SELECT count(*)::int AS cnt FROM public.${quoteIdent(tableName)} WHERE ${whereClause}`, params);
  return Number(result.rows[0]?.cnt || 0);
}

async function selectRows(
  client: PoolClient,
  tableName: string,
  whereClause: string,
  params: unknown[]
): Promise<Record<string, unknown>[]> {
  const result = await client.query(`SELECT * FROM public.${quoteIdent(tableName)} WHERE ${whereClause}`, params);
  return result.rows as Record<string, unknown>[];
}

async function deleteRows(client: PoolClient, tableName: string, whereClause: string, params: unknown[]): Promise<number> {
  const result = await client.query(`DELETE FROM public.${quoteIdent(tableName)} WHERE ${whereClause}`, params);
  return result.rowCount || 0;
}

async function getScopedSalesChannelIds(client: PoolClient, marketId: string): Promise<string[]> {
  if (!(await tableExists(client, "sales_channel"))) {
    return [];
  }

  const result = await client.query(
    `
      SELECT id
      FROM public.sales_channel
      WHERE metadata ->> 'gp_market_id' = $1
    `,
    [marketId]
  );

  return result.rows.map((row) => String(row.id)).filter(Boolean);
}

type ScopedMetadataTable = {
  tableName: string;
  columnName: string;
};

async function discoverMetadataScopedTables(client: PoolClient, marketId: string): Promise<ScopedMetadataTable[]> {
  const columnsResult = await client.query(
    `
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND udt_name = 'jsonb'
      ORDER BY table_name, column_name
    `
  );

  const discovered: ScopedMetadataTable[] = [];
  for (const row of columnsResult.rows as Array<{ table_name: string; column_name: string }>) {
    if (row.table_name === STORAGE_TABLE) {
      continue;
    }
    const tableName = row.table_name;
    const columnName = row.column_name;
    const count = await countRows(
      client,
      tableName,
      `${quoteIdent(columnName)} ->> 'gp_market_id' = $1`,
      [marketId]
    );
    if (count > 0) {
      discovered.push({ tableName, columnName });
    }
  }

  return discovered;
}

export function buildScopedDeleteOrder(metadataTables: string[], assignmentTables: string[]): string[] {
  const unique = new Set<string>();
  for (const table of assignmentTables) {
    unique.add(table);
  }
  for (const table of metadataTables) {
    unique.add(table);
  }

  const all = Array.from(unique);
  const withoutSalesChannel = all.filter((t) => t !== "sales_channel");
  if (all.includes("sales_channel")) {
    withoutSalesChannel.push("sales_channel");
  }
  return withoutSalesChannel;
}

async function exportScopedDbSnapshot(
  client: PoolClient,
  marketId: string
): Promise<{ snapshot: Record<string, unknown[]>; tableNames: string[] }> {
  const metadataScoped = await discoverMetadataScopedTables(client, marketId);
  const salesChannelIds = await getScopedSalesChannelIds(client, marketId);
  const snapshot: Record<string, unknown[]> = {};

  for (const entry of metadataScoped) {
    snapshot[entry.tableName] = await selectRows(
      client,
      entry.tableName,
      `${quoteIdent(entry.columnName)} ->> 'gp_market_id' = $1`,
      [marketId]
    );
  }

  if (salesChannelIds.length > 0) {
    for (const tableName of CHANNEL_ASSIGNMENT_TABLES) {
      if (!(await tableExists(client, tableName))) {
        continue;
      }
      snapshot[tableName] = await selectRows(client, tableName, `sales_channel_id = ANY($1::text[])`, [salesChannelIds]);
    }
  }

  return { snapshot, tableNames: Object.keys(snapshot).sort() };
}

async function deleteScopedDbConfig(client: PoolClient, args: CliArgs, report: Report): Promise<void> {
  const metadataScoped = await discoverMetadataScopedTables(client, args.marketId);
  const metadataTables = metadataScoped.map((t) => t.tableName);
  const salesChannelIds = await getScopedSalesChannelIds(client, args.marketId);

  const assignmentTables: string[] = [];
  if (salesChannelIds.length > 0) {
    for (const tableName of CHANNEL_ASSIGNMENT_TABLES) {
      if (await tableExists(client, tableName)) {
        assignmentTables.push(tableName);
      }
    }
  }

  const deleteOrder = buildScopedDeleteOrder(metadataTables, assignmentTables);
  for (const tableName of deleteOrder) {
    if (assignmentTables.includes(tableName)) {
      if (salesChannelIds.length === 0) {
        continue;
      }
      if (args.dryRun) {
        report.deleted += await countRows(client, tableName, `sales_channel_id = ANY($1::text[])`, [salesChannelIds]);
      } else {
        report.deleted += await deleteRows(client, tableName, `sales_channel_id = ANY($1::text[])`, [salesChannelIds]);
      }
      continue;
    }

    const metadata = metadataScoped.find((m) => m.tableName === tableName);
    if (!metadata) {
      continue;
    }

    const where = `${quoteIdent(metadata.columnName)} ->> 'gp_market_id' = $1`;
    if (args.dryRun) {
      report.deleted += await countRows(client, tableName, where, [args.marketId]);
    } else {
      report.deleted += await deleteRows(client, tableName, where, [args.marketId]);
    }
  }
}

export function mergeFill(current: unknown, incoming: unknown): { value: unknown; changed: boolean } {
  if (current === null || current === undefined || current === "") {
    return { value: clone(incoming), changed: true };
  }

  if (Array.isArray(current) && Array.isArray(incoming)) {
    if (current.length === 0 && incoming.length > 0) {
      return { value: clone(incoming), changed: true };
    }

    const idKeys = ["id", "product_id", "category_id", "vendor_id", "service_id"];
    const detectIdKey = (arr: unknown[]) => {
      for (const key of idKeys) {
        if (arr.every((item) => !isObject(item) || !item[key] || typeof item[key] === "string")) {
          const hasAny = arr.some((item) => isObject(item) && typeof item[key] === "string");
          if (hasAny) return key;
        }
      }
      return null;
    };

    const key = detectIdKey(current) || detectIdKey(incoming);
    if (!key) {
      return { value: current, changed: false };
    }

    const next = clone(current) as unknown[];
    let changed = false;
    const indexById = new Map<string, number>();
    next.forEach((item, index) => {
      if (isObject(item) && typeof item[key] === "string") {
        indexById.set(item[key] as string, index);
      }
    });

    for (const incomingItem of incoming) {
      if (!isObject(incomingItem) || typeof incomingItem[key] !== "string") {
        continue;
      }
      const id = incomingItem[key] as string;
      const currentIndex = indexById.get(id);
      if (currentIndex === undefined) {
        next.push(clone(incomingItem));
        changed = true;
        continue;
      }

      const merged = mergeFill(next[currentIndex], incomingItem);
      if (merged.changed) {
        next[currentIndex] = merged.value;
        changed = true;
      }
    }

    return { value: next, changed };
  }

  if (isObject(current) && isObject(incoming)) {
    const next = clone(current);
    let changed = false;
    for (const [key, incomingValue] of Object.entries(incoming)) {
      if (!(key in next)) {
        next[key] = clone(incomingValue);
        changed = true;
        continue;
      }
      const merged = mergeFill(next[key], incomingValue);
      if (merged.changed) {
        next[key] = merged.value;
        changed = true;
      }
    }
    return { value: next, changed };
  }

  return { value: current, changed: false };
}

async function ensureStorageTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${STORAGE_TABLE} (
      instance_id TEXT NOT NULL,
      market_id TEXT NOT NULL,
      section TEXT NOT NULL,
      record_key TEXT NOT NULL,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (instance_id, market_id, section, record_key)
    )
  `);
}

async function getExistingRows(client: PoolClient, instanceId: string, marketId: string): Promise<StoredRow[]> {
  const result = await client.query(
    `SELECT section, record_key, data FROM ${STORAGE_TABLE} WHERE instance_id = $1 AND market_id = $2`,
    [instanceId, marketId]
  );
  return result.rows as StoredRow[];
}

async function upsertRow(
  client: PoolClient,
  instanceId: string,
  marketId: string,
  section: StoredRow["section"],
  recordKey: string,
  data: unknown
): Promise<void> {
  await client.query(
    `
      INSERT INTO ${STORAGE_TABLE} (instance_id, market_id, section, record_key, data)
      VALUES ($1, $2, $3, $4, $5::jsonb)
      ON CONFLICT (instance_id, market_id, section, record_key)
      DO UPDATE SET data = EXCLUDED.data, updated_at = now()
    `,
    [instanceId, marketId, section, recordKey, JSON.stringify(data)]
  );
}

function makeIncomingRows(input: InputConfig): StoredRow[] {
  const rows: StoredRow[] = [];
  if (input.market) {
    rows.push({ section: "market", record_key: "market", data: input.market });
  }
  if (input.products) {
    rows.push({ section: "products", record_key: "products", data: input.products });
  }
  for (const [vendorId, vendorProducts] of Object.entries(input.vendors)) {
    rows.push({ section: "vendor_products", record_key: vendorId, data: vendorProducts });
  }
  return rows;
}

async function executeFill(client: PoolClient, args: CliArgs, input: InputConfig, report: Report): Promise<void> {
  const existingRows = await getExistingRows(client, args.instanceId, args.marketId);
  const existingMap = new Map(existingRows.map((r) => [`${r.section}:${r.record_key}`, r]));

  for (const incoming of makeIncomingRows(input)) {
    const key = `${incoming.section}:${incoming.record_key}`;
    const existing = existingMap.get(key);
    if (!existing) {
      report.inserted += 1;
      if (!args.dryRun) {
        await upsertRow(client, args.instanceId, args.marketId, incoming.section, incoming.record_key, incoming.data);
      }
      continue;
    }

    const merged = mergeFill(existing.data, incoming.data);
    if (merged.changed) {
      report.updated += 1;
      if (!args.dryRun) {
        await upsertRow(client, args.instanceId, args.marketId, incoming.section, incoming.record_key, merged.value);
      }
    } else {
      report.skipped += 1;
    }
  }
}

async function executeOverwrite(client: PoolClient, args: CliArgs, input: InputConfig, report: Report): Promise<void> {
  const existingRows = await getExistingRows(client, args.instanceId, args.marketId);
  report.deleted += existingRows.length;

  if (!args.dryRun) {
    await client.query(`DELETE FROM ${STORAGE_TABLE} WHERE instance_id = $1 AND market_id = $2`, [
      args.instanceId,
      args.marketId,
    ]);
  }

  await deleteScopedDbConfig(client, args, report);

  for (const row of makeIncomingRows(input)) {
    report.inserted += 1;
    if (!args.dryRun) {
      await upsertRow(client, args.instanceId, args.marketId, row.section, row.record_key, row.data);
    }
  }
}

async function executeDelete(client: PoolClient, args: CliArgs, report: Report): Promise<void> {
  const existingRows = await getExistingRows(client, args.instanceId, args.marketId);
  report.deleted += existingRows.length;
  if (!args.dryRun) {
    await client.query(`DELETE FROM ${STORAGE_TABLE} WHERE instance_id = $1 AND market_id = $2`, [
      args.instanceId,
      args.marketId,
    ]);
  }

  await deleteScopedDbConfig(client, args, report);
}

function defaultExportPath(repoRoot: string, instanceId: string, marketId: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(repoRoot, "GP", "export", "config", instanceId, "markets", marketId, `export-${timestamp}.yaml`);
}

async function executeExport(client: PoolClient, args: CliArgs, repoRoot: string, report: Report): Promise<void> {
  const rows = await getExistingRows(client, args.instanceId, args.marketId);
  const market = rows.find((r) => r.section === "market" && r.record_key === "market")?.data;
  const products = rows.find((r) => r.section === "products" && r.record_key === "products")?.data;
  const vendorRows = rows.filter((r) => r.section === "vendor_products");

  const vendors: Record<string, unknown> = {};
  for (const row of vendorRows) {
    vendors[row.record_key] = row.data;
  }

  const scopedDb = await exportScopedDbSnapshot(client, args.marketId);
  report.exported_tables = scopedDb.tableNames;

  const exportPayload = {
    meta: {
      generated_at: new Date().toISOString(),
      schema_version: "market-runtime-config.v1",
      instance_id: args.instanceId,
      market_id: args.marketId,
    },
    market: market ?? null,
    products: products ?? null,
    vendors,
    db_snapshot: scopedDb.snapshot,
  };

  const outputPath = args.outputPath
    ? path.resolve(args.outputPath)
    : defaultExportPath(repoRoot, args.instanceId, args.marketId);
  report.output_path = outputPath;

  if (args.dryRun) {
    report.skipped = rows.length;
    return;
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, yaml.dump(exportPayload, { noRefs: true, lineWidth: 120 }), "utf-8");
  report.inserted = rows.length;
}

async function withTransaction<T>(pool: Pool, action: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function runCli(rawArgs?: CliArgs): Promise<Report> {
  const repoRoot = detectRepoRoot(process.cwd());
  const args = rawArgs ?? parseArgs(repoRoot);

  ensureSafeDestructiveOperation(args);
  requireConfirmFlags(args);
  await requireInteractiveDeleteConfirmation(args);

  const dbUrl = args.dbUrl || process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error("DATABASE_URL is required (use --db-url or env DATABASE_URL).");
  }

  const report: Report = {
    ok: true,
    operation: args.operation,
    instance_id: args.instanceId,
    market_id: args.marketId,
    dry_run: args.dryRun,
    inserted: 0,
    updated: 0,
    skipped: 0,
    deleted: 0,
    warnings: [],
  };

  const pool = new Pool({ connectionString: dbUrl });
  try {
    if (args.operation === "export") {
      await withTransaction(pool, async (client) => {
        await ensureStorageTable(client);
        await executeExport(client, args, repoRoot, report);
      });
      return report;
    }

    const input = loadInputConfig(args, repoRoot);
    report.warnings.push(...input.warnings);
    if (args.dryRun) {
      log(args, "info", "Dry-run enabled: no database writes will be performed.");
    }

    await withTransaction(pool, async (client) => {
      await ensureStorageTable(client);

      if (args.operation === "fill") {
        await executeFill(client, args, input, report);
        return;
      }

      if (args.operation === "overwrite") {
        await executeOverwrite(client, args, input, report);
        return;
      }

      await executeDelete(client, args, report);
    });

    return report;
  } finally {
    await pool.end();
  }
}

async function main() {
  try {
    const report = await runCli();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
