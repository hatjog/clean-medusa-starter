import { Migration } from "@mikro-orm/migrations"

import { Migration20260505163000OperatorAlertEvaluatorTickHistoryTable as BaseMigration } from "../../packages/api/src/migrations/Migration20260505163000OperatorAlertEvaluatorTickHistoryTable"

export class Migration20260505163000OperatorAlertEvaluatorTickHistoryTable extends Migration {
  async up(): Promise<void> {
    const result = (await this.execute(
      "select to_regclass('public.operator_alert_evaluator_tick_history') as regclass",
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