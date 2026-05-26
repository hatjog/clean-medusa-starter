import { Migration20260526100000AddTranslationTables } from "../../migrations/Migration20260526100000_add_translation_tables"
import { Migration1778925265229 } from "../../modules/voucher/migrations/1778925265229_add_booking_pointer_to_entitlement_instance"

type RecordedSql = { sql: string; params: unknown[] }

class RecordingTranslationTablesMigration extends Migration20260526100000AddTranslationTables {
  public recorded: RecordedSql[] = []

  public override addSql(sql: string, ...args: any[]): any {
    this.recorded.push({ sql, params: args[0] ?? [] })
  }
}

class RecordingVoucherBookingPointerMigration extends Migration1778925265229 {
  public recorded: RecordedSql[] = []

  public override addSql(sql: string, ...args: any[]): any {
    this.recorded.push({ sql, params: args[0] ?? [] })
  }
}

describe("review-fix migracji Translation i rollback voucher", () => {
  it("nowa migracja Translation ma samodzielny schemat ownera", async () => {
    const migration = new (RecordingTranslationTablesMigration as any)()

    await migration.up()

    const sql = migration.recorded.map((entry) => entry.sql).join("\n")

    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "locale"/i)
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "translation"/i)
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "translation_settings"/i)
    expect(sql).toMatch(/"translated_field_count" integer NOT NULL DEFAULT 0/i)
    expect(sql).toMatch(/"is_active" boolean NOT NULL DEFAULT true/i)
    expect(sql).toMatch(/"IDX_translation_reference_id_locale_code_unique"/i)
    expect(sql).toMatch(/"IDX_translation_settings_entity_type_unique"/i)
  })

  it("nowa migracja Translation cofa tabele w odwrotnej kolejnosci", async () => {
    const migration = new (RecordingTranslationTablesMigration as any)()

    await migration.down()

    const sql = migration.recorded.map((entry) => entry.sql).join("\n")
    const settingsDrop = sql.indexOf('DROP TABLE IF EXISTS "translation_settings"')
    const translationDrop = sql.indexOf('DROP TABLE IF EXISTS "translation"')
    const localeDrop = sql.indexOf('DROP TABLE IF EXISTS "locale"')

    expect(settingsDrop).toBeGreaterThanOrEqual(0)
    expect(translationDrop).toBeGreaterThan(settingsDrop)
    expect(localeDrop).toBeGreaterThan(translationDrop)
  })

  it("historyczna migracja voucher nie tworzy juz tabel voucher", async () => {
    const migration = new (RecordingVoucherBookingPointerMigration as any)()

    await migration.up()

    const sql = migration.recorded.map((entry) => entry.sql).join("\n")

    expect(sql).not.toMatch(/CREATE TABLE IF NOT EXISTS\s+voucher\s*\(/i)
    expect(sql).not.toMatch(/CREATE TABLE IF NOT EXISTS\s+voucher_event\s*\(/i)
    expect(sql).toMatch(/ALTER TABLE entitlement_instance/i)
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS booking_pointer/i)
  })

  it("rollback voucher archiwizuje wiersze audytu przed usunieciem", async () => {
    const migration = new (RecordingVoucherBookingPointerMigration as any)()

    await migration.down()

    const sql = migration.recorded.map((entry) => entry.sql).join("\n")
    const archiveTable = sql.indexOf("CREATE TABLE IF NOT EXISTS voucher_event_archive")
    const archiveInsert = sql.indexOf("INSERT INTO voucher_event_archive")
    const deleteAuditRows = sql.indexOf("DELETE FROM voucher_event")
    const constraintRestore = sql.indexOf("ADD CONSTRAINT voucher_event_event_type_check")

    expect(archiveTable).toBeGreaterThanOrEqual(0)
    expect(archiveInsert).toBeGreaterThan(archiveTable)
    expect(deleteAuditRows).toBeGreaterThan(archiveInsert)
    expect(constraintRestore).toBeGreaterThan(deleteAuditRows)
    expect(sql).toMatch(/archived_count <> before_count/i)
  })

  it("rollback voucher zachowuje liczbe wierszy audytu przez tabele archiwum", () => {
    const liveBefore = [
      { id: "evt_1", event_type: "created" },
      { id: "evt_2", event_type: "ENTITLEMENT_BOOKING_CANCELLED" },
      { id: "evt_3", event_type: "ENTITLEMENT_BOOKING_CANCELLED" },
    ]
    const archiveBefore: typeof liveBefore = []

    const moved = liveBefore.filter(
      (row) => row.event_type === "ENTITLEMENT_BOOKING_CANCELLED"
    )
    const liveAfter = liveBefore.filter(
      (row) => row.event_type !== "ENTITLEMENT_BOOKING_CANCELLED"
    )
    const archiveAfter = [...archiveBefore, ...moved]

    const preRollbackCount = moved.length
    const postRollbackCount =
      liveAfter.filter((row) => row.event_type === "ENTITLEMENT_BOOKING_CANCELLED")
        .length +
      archiveAfter.filter((row) => row.event_type === "ENTITLEMENT_BOOKING_CANCELLED")
        .length

    expect(postRollbackCount).toBe(preRollbackCount)
  })
})
