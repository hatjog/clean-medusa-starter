import { Migration } from "@mikro-orm/migrations"

/**
 * Story v160-8-5 closure: durable alert-evaluator scheduler heartbeat.
 *
 * Records every tick, including zero-firing passes and failures, so operators
 * can distinguish an idle-but-healthy evaluator from a scheduler that never ran.
 */
export class Migration20260505163000OperatorAlertEvaluatorTickHistoryTable extends Migration {
  async up(): Promise<void> {
    this.addSql(
      `CREATE TABLE operator_alert_evaluator_tick_history (
        id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
        schedule_name text NOT NULL,
        triggered_by text NOT NULL CHECK (triggered_by IN ('manual', 'scheduler')),
        tick_started_at timestamptz NOT NULL,
        tick_finished_at timestamptz NOT NULL,
        firing_count integer NOT NULL DEFAULT 0,
        auto_rollbacks integer NOT NULL DEFAULT 0,
        status text NOT NULL CHECK (status IN ('pass', 'fail')),
        error_message text NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
    )

    this.addSql(
      `CREATE INDEX idx_operator_alert_evaluator_tick_history_started_at
       ON operator_alert_evaluator_tick_history (tick_started_at DESC)`,
    )
  }

  async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS operator_alert_evaluator_tick_history`)
  }
}