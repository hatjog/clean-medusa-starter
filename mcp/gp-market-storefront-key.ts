import crypto from "node:crypto";
import process from "node:process";

import { Pool } from "pg";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

type CliArgs = {
  marketId: string;
  dbUrl?: string;
  title?: string;
  createdBy: string;
  dryRun: boolean;
  revealToken: boolean;
  logLevel: "info" | "warn" | "debug";
};

type EnsureResult = {
  ok: boolean;
  market_id: string;
  sales_channel_id: string;
  publishable_key_id: string;
  publishable_key_redacted: string;
  publishable_key_token?: string;
  created: boolean;
};

const CROCKFORD32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeTime(timeMs: number): string {
  let value = BigInt(timeMs);
  let out = "";
  for (let i = 0; i < 10; i++) {
    const mod = Number(value % 32n);
    out = CROCKFORD32[mod] + out;
    value = value / 32n;
  }
  return out;
}

function encodeRandom(bytes: Uint8Array): string {
  let buffer = 0;
  let bufferBits = 0;
  let out = "";

  for (const b of bytes) {
    buffer = (buffer << 8) | b;
    bufferBits += 8;
    while (bufferBits >= 5) {
      const shift = bufferBits - 5;
      const index = (buffer >> shift) & 31;
      out += CROCKFORD32[index];
      bufferBits -= 5;
      buffer = buffer & ((1 << bufferBits) - 1);
    }
  }

  if (bufferBits > 0) {
    const index = (buffer << (5 - bufferBits)) & 31;
    out += CROCKFORD32[index];
  }

  return out;
}

function ulid(): string {
  const timePart = encodeTime(Date.now());
  const randomBytes = crypto.randomBytes(10); // 80 bits
  const randomPart = encodeRandom(randomBytes);
  return (timePart + randomPart).slice(0, 26);
}

function redactToken(token: string): string {
  const prefix = token.slice(0, 6);
  const suffix = token.slice(-3);
  return `${prefix}***${suffix}`;
}

function log(args: CliArgs, level: "debug" | "info" | "warn", message: string) {
  const priority: Record<typeof level, number> = { debug: 10, info: 20, warn: 30 };
  if (priority[level] < priority[args.logLevel]) {
    return;
  }
  const stream = level === "warn" ? process.stderr : process.stdout;
  stream.write(`[${level}] ${message}\n`);
}

function parseArgs(): CliArgs {
  const argv = yargs(hideBin(process.argv))
    .scriptName("gp-market-storefront-key")
    .option("market-id", { type: "string", demandOption: true })
    .option("db-url", { type: "string" })
    .option("title", { type: "string" })
    .option("created-by", { type: "string", default: "gp-market-storefront-key" })
    .option("dry-run", { type: "boolean", default: false })
    .option("reveal-token", { type: "boolean", default: false })
    .option("log-level", {
      choices: ["debug", "info", "warn"] as const,
      default: "info" as const,
    })
    .strict()
    .parseSync();

  return {
    marketId: argv["market-id"],
    dbUrl: argv["db-url"],
    title: argv.title,
    createdBy: argv["created-by"],
    dryRun: argv["dry-run"],
    revealToken: argv["reveal-token"],
    logLevel: argv["log-level"],
  };
}

async function tableExists(pool: Pool, tableName: string): Promise<boolean> {
  const res = await pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1 LIMIT 1`,
    [tableName]
  );
  return res.rowCount > 0;
}

async function ensureSchema(pool: Pool): Promise<void> {
  const required = ["sales_channel", "api_key", "publishable_api_key_sales_channel"];
  for (const t of required) {
    if (!(await tableExists(pool, t))) {
      throw new Error(`Missing required table '${t}' (wrong DB or migrations not applied).`);
    }
  }
}

async function findMarketSalesChannelId(pool: Pool, marketId: string): Promise<string> {
  const res = await pool.query(
    `
    SELECT id
    FROM public.sales_channel
    WHERE deleted_at IS NULL
      AND metadata ->> 'gp_market_id' = $1
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [marketId]
  );

  const id = res.rows?.[0]?.id;
  if (!id) {
    throw new Error(
      `Missing sales_channel for market_id='${marketId}'. Create it first (e.g. seed/reconcile) with metadata.gp_market_id.`
    );
  }
  return String(id);
}

async function findAssignedPublishableKey(pool: Pool, salesChannelId: string): Promise<{ id: string; token: string; redacted: string } | null> {
  const res = await pool.query(
    `
    SELECT ak.id, ak.token, ak.redacted
    FROM public.publishable_api_key_sales_channel pasc
    JOIN public.api_key ak
      ON ak.id = pasc.publishable_key_id
    WHERE pasc.deleted_at IS NULL
      AND ak.deleted_at IS NULL
      AND ak.type = 'publishable'
      AND pasc.sales_channel_id = $1
    ORDER BY ak.created_at DESC
    LIMIT 1
    `,
    [salesChannelId]
  );

  if (!res.rowCount) {
    return null;
  }

  return {
    id: String(res.rows[0].id),
    token: String(res.rows[0].token),
    redacted: String(res.rows[0].redacted),
  };
}

async function insertPublishableKey(pool: Pool, token: string, title: string, createdBy: string): Promise<{ id: string; redacted: string }> {
  const id = `apk_${ulid()}`;
  const salt = crypto.randomBytes(16).toString("hex");
  const redacted = redactToken(token);

  await pool.query(
    `
    INSERT INTO public.api_key (
      id, token, salt, redacted, title, type, created_by, created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, 'publishable', $6, now(), now()
    )
    `,
    [id, token, salt, redacted, title, createdBy]
  );

  return { id, redacted };
}

async function assignPublishableKeyToSalesChannel(pool: Pool, publishableKeyId: string, salesChannelId: string): Promise<void> {
  const id = `pasc_${ulid()}`;
  await pool.query(
    `
    INSERT INTO public.publishable_api_key_sales_channel (
      publishable_key_id, sales_channel_id, id, created_at, updated_at
    ) VALUES (
      $1, $2, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
    ON CONFLICT (publishable_key_id, sales_channel_id) DO NOTHING
    `,
    [publishableKeyId, salesChannelId, id]
  );
}

async function ensureMarketPublishableKey(args: CliArgs): Promise<EnsureResult> {
  const dbUrl = args.dbUrl || process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error("Missing --db-url and DATABASE_URL env var is not set.");
  }

  const pool = new Pool({ connectionString: dbUrl });
  try {
    await ensureSchema(pool);

    const salesChannelId = await findMarketSalesChannelId(pool, args.marketId);
    log(args, "info", `Resolved sales_channel_id='${salesChannelId}' for market_id='${args.marketId}'.`);

    const existing = await findAssignedPublishableKey(pool, salesChannelId);
    if (existing) {
      return {
        ok: true,
        market_id: args.marketId,
        sales_channel_id: salesChannelId,
        publishable_key_id: existing.id,
        publishable_key_redacted: existing.redacted,
        publishable_key_token: args.revealToken ? existing.token : undefined,
        created: false,
      };
    }

    const title = args.title || `storefront-${args.marketId}`;
    const token = `pk_${crypto.randomBytes(32).toString("hex")}`;

    if (args.dryRun) {
      return {
        ok: true,
        market_id: args.marketId,
        sales_channel_id: salesChannelId,
        publishable_key_id: "(dry-run)",
        publishable_key_redacted: redactToken(token),
        publishable_key_token: args.revealToken ? token : undefined,
        created: false,
      };
    }

    const inserted = await insertPublishableKey(pool, token, title, args.createdBy);
    await assignPublishableKeyToSalesChannel(pool, inserted.id, salesChannelId);

    return {
      ok: true,
      market_id: args.marketId,
      sales_channel_id: salesChannelId,
      publishable_key_id: inserted.id,
      publishable_key_redacted: inserted.redacted,
      publishable_key_token: token,
      created: true,
    };
  } finally {
    await pool.end();
  }
}

async function main() {
  const args = parseArgs();
  const result = await ensureMarketPublishableKey(args);

  // By default we do NOT print full tokens unless explicitly requested.
  if (!args.revealToken && result.publishable_key_token) {
    delete result.publishable_key_token;
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((err) => {
  process.stderr.write(`[error] ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
