import fs from "node:fs"
import path from "node:path"

import { Migration1779016000000 } from "../../modules/voucher/migrations/1779016000000_runtime_recovery_rls_boundary"

const TABLES = ["voucher_claim_audit", "voucher_claim_binding", "event_processed"] as const
const REPO_ROOT = path.resolve(__dirname, "../../../../../../..")

function migrationSql(): string {
  const commands: string[] = []
  const fakeThis = { addSql: (command: string) => commands.push(command) }
  ;(Migration1779016000000.prototype as any).up.call(fakeThis)
  return commands.join("\n")
}

describe("runtime recovery provisioning contract", () => {
  const sql = migrationSql()
  const provisioning = fs.readFileSync(
    path.join(REPO_ROOT, "infra/postgres/migrations/003-rls-market-isolation.sql"),
    "utf8"
  )

  it("oddziela rolę migracyjną od runtime i wymusza RLS na wszystkich trzech tabelach", () => {
    expect(sql).toContain("CREATE ROLE gp_runtime_recovery_migrator NOLOGIN NOBYPASSRLS")
    expect(sql).toContain("ALTER ROLE gp_runtime_recovery_migrator NOLOGIN NOBYPASSRLS")
    for (const table of TABLES) {
      expect(sql).toContain(`ALTER TABLE ${table} OWNER TO gp_runtime_recovery_migrator`)
      expect(sql).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`)
      expect(sql).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`)
      expect(sql).toContain(`REVOKE ALL PRIVILEGES ON ${table} FROM medusa_store`)
    }
  })

  it("nadaje runtime tylko minimalne DML i chroni append-only audit oraz dedupe", () => {
    expect(sql).toContain("GRANT SELECT, INSERT ON voucher_claim_audit TO medusa_store")
    expect(sql).toContain("GRANT SELECT, INSERT ON event_processed TO medusa_store")
    expect(sql).toContain("GRANT SELECT, INSERT, UPDATE ON voucher_claim_binding TO medusa_store")
    expect(sql).not.toContain("GRANT SELECT, INSERT, UPDATE, DELETE ON voucher_claim_audit TO medusa_store")
    expect(sql).not.toContain("GRANT SELECT, INSERT, UPDATE, DELETE ON event_processed TO medusa_store")
    expect(sql).toContain("GRANT USAGE ON SEQUENCE voucher_claim_audit_audit_id_seq TO medusa_store")
  })

  it("końcowy guard reprovisioningu odbiera UPDATE/DELETE po każdym szerokim grancie infrastruktury", () => {
    expect(provisioning).toContain("'voucher_claim_audit'")
    expect(provisioning).toContain("'voucher_claim_binding'")
    expect(provisioning).toContain("'event_processed'")
    expect(provisioning).toContain("REVOKE ALL PRIVILEGES ON TABLE public.%I FROM medusa_store")
    expect(provisioning).toContain("GRANT SELECT, INSERT, UPDATE ON TABLE public.voucher_claim_binding TO medusa_store")
    expect(provisioning).toContain("GRANT SELECT, INSERT ON TABLE public.%I TO medusa_store")
  })
})
