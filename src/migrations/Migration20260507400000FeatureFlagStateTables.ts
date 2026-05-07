import { Migration } from "@mikro-orm/migrations"

import { Migration20260507400000FeatureFlagStateTables as BaseMigration } from "../../packages/api/src/migrations/Migration20260507400000FeatureFlagStateTables"

export class Migration20260507400000FeatureFlagStateTables extends Migration {
  async up(): Promise<void> {
    const result = (await this.execute(
      "select to_regclass('public.feature_flag_state') as regclass",
    )) as Array<{ regclass?: string | null }> | { rows?: Array<{ regclass?: string | null }> }

    const row = Array.isArray(result) ? result[0] : result?.rows?.[0]
    const tableExists = Boolean(row?.regclass)

    // H3 fix: AC7(b) requires GP_MV_FLAG_STATE env-var fallback at seed time.
    // The base migration's DO block reads `current_setting('app.gp_mv_flag_state', true)`
    // — a Postgres GUC that the migration runner does NOT set from process env
    // by default. Set it explicitly here (SET LOCAL is scoped to this txn) so
    // the SQL fallback chain reaches branch (b).
    const envValue = process.env.GP_MV_FLAG_STATE
    if (envValue && ["off", "shadow", "on"].includes(envValue)) {
      // SET LOCAL is safe — scoped to current txn; psql parameter escape via
      // single-quote doubling. The value is already validated against the
      // allow-list above so this is a closed enum, not user input.
      await this.execute(
        `SET LOCAL app.gp_mv_flag_state = '${envValue.replace(/'/g, "''")}'`,
      )
    }

    if (tableExists) {
      // M2 fix: even if up() previously created the tables, run nothing here
      // so we do not double-seed; down() still drops with IF EXISTS so the
      // pair remains symmetric for the common case where tables were created
      // by this migration originally.
      return
    }

    await new BaseMigration(this.driver, this.config).up()
  }

  async down(): Promise<void> {
    // M2 note: BaseMigration.down uses DROP TABLE IF EXISTS so this is
    // idempotent and safe even if up() was a no-op.
    await new BaseMigration(this.driver, this.config).down()
  }
}
