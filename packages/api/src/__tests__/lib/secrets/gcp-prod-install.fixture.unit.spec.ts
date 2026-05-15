/**
 * F10 — Sprint 5 gate (AC6).
 *
 * Authored now as a SKIPPED fixture. It does NOT need to pass in Sprint 1.
 * It is the executable spec the Sprint 5 owner arms to prove that the
 * @google-cloud/secret-manager devDependency survives a prod-like install
 * and that gcp-adapter.ts has a guaranteed build artifact post-install
 * (i.e. it is NOT stripped from the runtime build).
 *
 * Sprint 5 owner: run inside the staging build job context with
 *   pnpm install --filter=@gp/backend --prod=false
 * then un-skip and assert the artifact + module are present.
 */
import * as fs from "fs"
import * as path from "path"

// F10 — Sprint 5 gate: change `describe.skip` → `describe` to arm.
describe.skip("F10 — gcp-adapter survives prod-like install (Sprint 5 gate)", () => {
  it("gcp-adapter source is present and references the SDK", () => {
    const src = path.join(__dirname, "../../../lib/secrets/gcp-adapter.ts")
    expect(fs.existsSync(src)).toBe(true)
    const content = fs.readFileSync(src, "utf8")
    expect(content).toContain("@google-cloud/secret-manager")
  })

  it("compiled gcp-adapter artifact exists after prod-like build", () => {
    // F10 — Sprint 5 gate: assert the built artifact path produced by the
    // staging build job (e.g. .medusa/server/.../gcp-adapter.js). Path is
    // finalized by the Sprint 5 owner against the actual build output layout.
    const builtCandidates = [
      path.join(
        __dirname,
        "../../../../.medusa/server/src/lib/secrets/gcp-adapter.js"
      ),
    ]
    expect(builtCandidates.some((p) => fs.existsSync(p))).toBe(true)
  })

  it("@google-cloud/secret-manager resolves after prod-like install", () => {
    // F10 — Sprint 5 gate: with pnpm install --prod=false in the staging
    // build job, the devDependency must resolve.
    expect(() => require.resolve("@google-cloud/secret-manager")).not.toThrow()
  })
})
