import fs from "fs"
import path from "path"

import dotenv from "dotenv"
import { Client } from "pg"

for (const file of [".env", ".env.local"]) {
  const fullPath = path.join(process.cwd(), file)

  if (fs.existsSync(fullPath)) {
    dotenv.config({ path: fullPath, override: true })
  }
}

const databaseUrl = process.env.DATABASE_URL || process.env.GP_CORE_DATABASE_URL

if (!databaseUrl) {
  throw new Error("DATABASE_URL or GP_CORE_DATABASE_URL is required")
}

async function main() {
  const client = new Client({ connectionString: databaseUrl })

  await client.connect()

  try {
    const rateColumnsResult = await client.query<{ column_name: string }>(
      `select column_name
       from information_schema.columns
       where table_schema = 'public' and table_name = 'commission_rate'`,
    )
    const ruleColumnsResult = await client.query<{ column_name: string }>(
      `select column_name
       from information_schema.columns
       where table_schema = 'public' and table_name = 'commission_rule'`,
    )
    const lineColumnsResult = await client.query<{ column_name: string }>(
      `select column_name
       from information_schema.columns
       where table_schema = 'public' and table_name = 'commission_line'`,
    )

    const rateColumns = new Set(rateColumnsResult.rows.map((row) => row.column_name))
    const ruleColumns = new Set(ruleColumnsResult.rows.map((row) => row.column_name))
    const lineColumns = new Set(lineColumnsResult.rows.map((row) => row.column_name))

    const hasCoreShape =
      rateColumns.has("is_enabled") &&
      rateColumns.has("priority") &&
      rateColumns.has("target") &&
      rateColumns.has("value") &&
      !rateColumns.has("rule_id") &&
      lineColumns.has("item_id") &&
      lineColumns.has("commission_rate_id") &&
      lineColumns.has("amount")

    const hasLegacyShape =
      !hasCoreShape &&
      (
        (rateColumns.has("percentage_rate") && rateColumns.has("rule_id")) ||
        lineColumns.has("item_line_id") ||
        lineColumns.has("rule_id") ||
        ruleColumns.has("name")
      )

    if (!hasLegacyShape) {
      console.log("Commission schema repair not needed.")
      return
    }

    const countResult = await client.query<{ table_name: string; rows: string }>(
      `select 'commission_rate' as table_name, count(*)::text as rows from commission_rate
       union all
       select 'commission_rule', count(*)::text from commission_rule
       union all
       select 'commission_line', count(*)::text from commission_line`,
    )

    const nonEmptyTables = countResult.rows.filter((row) => row.rows !== "0")

    await client.query("BEGIN")

    if (nonEmptyTables.length === 0) {
      await client.query("DROP TABLE IF EXISTS commission_line CASCADE")
      await client.query("DROP TABLE IF EXISTS commission_rule CASCADE")
      await client.query("DROP TABLE IF EXISTS commission_rate CASCADE")
      await client.query("COMMIT")

      console.log("Dropped empty legacy commission tables. Re-run 'medusa db:migrate' to apply the current commission schema.")
      return
    }

    await client.query(`ALTER TABLE commission_rate ADD COLUMN IF NOT EXISTS is_enabled boolean`)
    await client.query(`ALTER TABLE commission_rate ADD COLUMN IF NOT EXISTS priority integer`)
    await client.query(`ALTER TABLE commission_rate ADD COLUMN IF NOT EXISTS currency_code text`)
    await client.query(`ALTER TABLE commission_rate ADD COLUMN IF NOT EXISTS name text`)
    await client.query(`ALTER TABLE commission_rate ADD COLUMN IF NOT EXISTS code text`)
    await client.query(`ALTER TABLE commission_rate ADD COLUMN IF NOT EXISTS target text`)
    await client.query(`ALTER TABLE commission_rate ADD COLUMN IF NOT EXISTS value numeric`)
    await client.query(`ALTER TABLE commission_rate ADD COLUMN IF NOT EXISTS min_amount numeric`)
    await client.query(`ALTER TABLE commission_rate ADD COLUMN IF NOT EXISTS raw_value jsonb`)
    await client.query(`ALTER TABLE commission_rate ADD COLUMN IF NOT EXISTS raw_min_amount jsonb`)

    await client.query(`ALTER TABLE commission_rule ADD COLUMN IF NOT EXISTS commission_rate_id text`)

    await client.query(`ALTER TABLE commission_line ADD COLUMN IF NOT EXISTS item_id text`)
    await client.query(`ALTER TABLE commission_line ADD COLUMN IF NOT EXISTS commission_rate_id text`)
    await client.query(`ALTER TABLE commission_line ADD COLUMN IF NOT EXISTS code text`)
    await client.query(`ALTER TABLE commission_line ADD COLUMN IF NOT EXISTS rate double precision`)
    await client.query(`ALTER TABLE commission_line ADD COLUMN IF NOT EXISTS amount numeric`)
    await client.query(`ALTER TABLE commission_line ADD COLUMN IF NOT EXISTS description text`)
    await client.query(`ALTER TABLE commission_line ADD COLUMN IF NOT EXISTS raw_amount jsonb`)

    await client.query(`
      UPDATE commission_rule rule
      SET commission_rate_id = rate.id
      FROM commission_rate rate
      WHERE rate.rule_id = rule.id
        AND (rule.commission_rate_id IS NULL OR rule.commission_rate_id = '')
    `)

    await client.query(`
      UPDATE commission_rate rate
      SET
        is_enabled = COALESCE(is_enabled, true),
        priority = COALESCE(priority, 0),
        currency_code = rate.currency_code,
        name = COALESCE(rate.name, rule.name, 'default'),
        code = COALESCE(rate.code, rule.name, 'default'),
        target = COALESCE(rate.target, 'item'),
        value = COALESCE(rate.value, rate.percentage_rate),
        min_amount = rate.min_amount,
        raw_value = COALESCE(rate.raw_value, jsonb_build_object('value', COALESCE(rate.value, rate.percentage_rate)::text)),
        raw_min_amount = COALESCE(
          rate.raw_min_amount,
          CASE WHEN rate.min_amount IS NULL THEN NULL ELSE jsonb_build_object('value', rate.min_amount::text) END
        )
      FROM commission_rule rule
      WHERE rule.id = rate.rule_id
    `)

    await client.query(`
      UPDATE commission_line line
      SET
        item_id = COALESCE(line.item_id, line.item_line_id),
        commission_rate_id = COALESCE(line.commission_rate_id, rate.id),
        code = COALESCE(line.code, rate.code, 'default'),
        rate = COALESCE(line.rate, rate.value::double precision),
        amount = COALESCE(line.amount, line.value),
        description = line.description,
        raw_amount = COALESCE(line.raw_amount, line.raw_value, jsonb_build_object('value', COALESCE(line.amount, line.value)::text))
      FROM commission_rule rule
      JOIN commission_rate rate ON rate.rule_id = rule.id
      WHERE line.rule_id = rule.id
    `)

    await client.query(`ALTER TABLE commission_line DROP COLUMN IF EXISTS item_line_id`)
    await client.query(`ALTER TABLE commission_line DROP COLUMN IF EXISTS rule_id`)
    await client.query(`ALTER TABLE commission_line DROP COLUMN IF EXISTS currency_code`)
    await client.query(`ALTER TABLE commission_line DROP COLUMN IF EXISTS value`)
    await client.query(`ALTER TABLE commission_line DROP COLUMN IF EXISTS raw_value`)

    await client.query(`
      UPDATE commission_rule
      SET commission_rate_id = NULL
      WHERE reference = 'site'
        AND COALESCE(reference_id, '') = ''
    `)

    await client.query("COMMIT")

    console.log(
      `Migrated legacy commission schema in place and preserved data: ${JSON.stringify(nonEmptyTables)}`,
    )
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    await client.end()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})