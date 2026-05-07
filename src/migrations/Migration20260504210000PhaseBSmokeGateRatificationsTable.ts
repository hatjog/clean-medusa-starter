import { Migration } from "@mikro-orm/migrations"

import { Migration20260504210000PhaseBSmokeGateRatificationsTable as BaseMigration } from "../../packages/api/src/migrations/Migration20260504210000PhaseBSmokeGateRatificationsTable"

export class Migration20260504210000PhaseBSmokeGateRatificationsTable extends Migration {
  async up(): Promise<void> {
    const result = (await this.execute(
      "select to_regclass('public.phase_b_smoke_gate_ratifications') as regclass",
    )) as Array<{ regclass?: string | null }> | { rows?: Array<{ regclass?: string | null }> }

    const row = Array.isArray(result) ? result[0] : result?.rows?.[0]
    if (row?.regclass) {
      return
    }

    await new BaseMigration(this.driver, this.config).up()
  }

  async down(): Promise<void> {
    await new BaseMigration(this.driver, this.config).down()
  }
}