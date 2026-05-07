import { Migration } from "@mikro-orm/migrations"

import { Migration20260505110000OperatorMultiVendorFlagAuditTable as BaseMigration } from "../../packages/api/src/migrations/Migration20260505110000OperatorMultiVendorFlagAuditTable"

export class Migration20260505110000OperatorMultiVendorFlagAuditTable extends Migration {
  async up(): Promise<void> {
    const result = (await this.execute(
      "select to_regclass('public.operator_multi_vendor_flag_audit') as regclass",
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