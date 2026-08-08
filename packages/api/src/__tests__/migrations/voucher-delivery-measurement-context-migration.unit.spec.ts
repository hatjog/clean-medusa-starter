import { Migration1779014000000 } from "../../modules/voucher/migrations/1779014000000_add_delivery_measurement_context"

class RecordingMigration extends Migration1779014000000 {
  readonly recorded: string[] = []

  public override addSql(sql: string): void {
    this.recorded.push(sql)
  }
}

async function runUp(): Promise<string> {
  const migration = new RecordingMigration(
    undefined as unknown as ConstructorParameters<
      typeof Migration1779014000000
    >[0],
    undefined as unknown as ConstructorParameters<
      typeof Migration1779014000000
    >[1],
  )
  await migration.up()
  return migration.recorded.join("\n").replace(/\s+/g, " ")
}

describe("Migration1779014000000 — kontekst pomiaru dostawy (Story 4.8, AC1)", () => {
  it("dodaje env i instance_id NOT NULL z CHECK do obu tabel", async () => {
    const sql = await runUp()

    for (const table of [
      "voucher_delivery_dispatch",
      "voucher_delivery_dispatch_audit",
    ]) {
      expect(sql).toContain(`ALTER TABLE ${table}`)
    }
    expect(
      sql.match(/ADD COLUMN IF NOT EXISTS env text NOT NULL/g),
    ).toHaveLength(2)
    expect(
      sql.match(/ADD COLUMN IF NOT EXISTS instance_id text NOT NULL/g),
    ).toHaveLength(2)
    expect(sql.match(/CHECK \(char_length\(env\) > 0\)/g)).toHaveLength(2)
    expect(sql.match(/CHECK \(char_length\(instance_id\) > 0\)/g)).toHaveLength(
      2,
    )
  })

  it("etykietuje zastane wiersze jako unattributed i usuwa default dla nowych zapisów", async () => {
    const sql = await runUp()

    expect(sql.match(/DEFAULT 'unattributed'/g)).toHaveLength(4)
    expect(sql.match(/ALTER COLUMN env DROP DEFAULT/g)).toHaveLength(2)
    expect(sql.match(/ALTER COLUMN instance_id DROP DEFAULT/g)).toHaveLength(2)
  })

  it("jest addytywna i ma non-destrukcyjny down", async () => {
    const sql = await runUp()
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i)
    expect(sql).not.toMatch(/\bDELETE\b|\bTRUNCATE\b/i)

    const migration = new RecordingMigration(
      undefined as unknown as ConstructorParameters<
        typeof Migration1779014000000
      >[0],
      undefined as unknown as ConstructorParameters<
        typeof Migration1779014000000
      >[1],
    )
    await migration.down()
    expect(migration.recorded).toHaveLength(0)
  })
})
