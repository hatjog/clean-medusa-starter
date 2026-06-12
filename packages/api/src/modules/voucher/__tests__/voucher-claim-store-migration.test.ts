import { Migration1778931000000 } from "../migrations/1778931000000_create_voucher_claim_store"

describe("Story 6.1 — durable voucher claim store migration", () => {
  function collectSql(): string {
    const migration = new Migration1778931000000({} as never, {} as never)
    const statements: string[] = []
    jest.spyOn(migration, "addSql").mockImplementation((sql: string) => {
      statements.push(sql)
    })
    migration.up()
    return statements.join("\n")
  }

  it("tworzy voucher_claim_binding z PK po idempotency_key i TTL expires_at", () => {
    const sql = collectSql()

    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS voucher_claim_binding/)
    expect(sql).toMatch(/idempotency_key\s+text PRIMARY KEY/)
    expect(sql).toMatch(/binding_hash\s+text NOT NULL/)
    expect(sql).toMatch(/response_status\s+integer NULL/)
    expect(sql).toMatch(/response_body\s+jsonb NULL/)
    expect(sql).toMatch(/expires_at\s+timestamptz NOT NULL/)
    expect(sql).toMatch(/voucher_claim_binding_expires_at_idx/)
  })

  it("tworzy append-only voucher_claim_audit z outcome vocabulary claim-route", () => {
    const sql = collectSql()

    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS voucher_claim_audit/)
    expect(sql).toMatch(/audit_id\s+bigserial PRIMARY KEY/)
    expect(sql).toMatch(/'idempotent_replay'/)
    expect(sql).toMatch(/'replay_tampered'/)
    expect(sql).toMatch(/voucher_claim_audit_idempotency_key_idx/)
  })

  it("down jest non-destrukcyjny", async () => {
    const migration = new Migration1778931000000({} as never, {} as never)
    const addSql = jest.spyOn(migration, "addSql")

    await migration.down()

    expect(addSql).not.toHaveBeenCalled()
  })
})
