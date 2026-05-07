import { Migration } from "@mikro-orm/migrations";

/**
 * Story v160-8-5 closure: durable alert firing history.
 *
 * Stores the operator-visible 24h alert history so alert evidence survives
 * process restarts and can be correlated with automated rollback entries.
 */
export class Migration20260505123000OperatorAlertFiringHistoryTable extends Migration {
  async up(): Promise<void> {
    this.addSql(
      `CREATE TABLE operator_alert_firing_history (
        id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
        alert_id text NOT NULL,
        severity text NOT NULL CHECK (severity IN ('P1', 'P2', 'P3')),
        action text NOT NULL CHECK (action IN ('auto_rollback', 'page', 'alert')),
        evaluated_value jsonb NULL,
        firing_since timestamptz NOT NULL,
        computed_at timestamptz NOT NULL DEFAULT now()
      )`
    )

    this.addSql(
      `CREATE INDEX idx_operator_alert_firing_history_firing_since
       ON operator_alert_firing_history (firing_since DESC)`
    )
  }

  async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS operator_alert_firing_history`)
  }
}