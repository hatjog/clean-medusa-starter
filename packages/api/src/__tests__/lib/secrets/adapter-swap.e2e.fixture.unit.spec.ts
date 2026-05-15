/**
 * F4 — Sprint 5 gate (AC7).
 *
 * Authored now as a SKIPPED fixture. It does NOT need to pass in Sprint 1.
 * It is the executable spec the Sprint 5 owner arms to prove the adapter
 * SELECTION mechanism works at runtime (not merely code-complete): flipping
 * SECRETS_ADAPTER=env → gcp in an isolated container, against a MOCKED GCP
 * Secret Manager endpoint (NEVER a real GCP project, NEVER production data).
 *
 * Sprint 5 owner: stand up the mocked GCP endpoint, un-skip, and assert the
 * loader returns a gcp-backed adapter that resolves a mocked secret.
 */
import secretsLoader from "../../../loaders/secrets"

// F4 — Sprint 5 gate: change `describe.skip` → `describe` to arm.
describe.skip("F4 — adapter swap env→gcp E2E with mocked GCP (Sprint 5 gate)", () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  afterAll(() => {
    process.env = originalEnv
  })

  it("env mode resolves Stripe key from process.env", async () => {
    process.env.SECRETS_ADAPTER = "env"
    process.env.STRIPE_SECRET_KEY_BONBEAUTY = "sk_test_env_path"
    let captured: { getStripeKey: Function } | undefined
    const container = {
      register: (_k: string, r: { resolve: () => unknown }) => {
        captured = (r.resolve ? r.resolve() : r) as never
      },
    }
    await secretsLoader({ container: container as never })
    const key = await captured!.getStripeKey("bonbeauty", "secret")
    expect(key).toBe("sk_test_env_path")
  })

  it("gcp mode resolves Stripe key from MOCKED GCP Secret Manager", async () => {
    // F4 — Sprint 5 gate: inject a mocked SecretManagerServiceClient
    // (jest.mock("@google-cloud/secret-manager", ...)) returning a
    // sk_test_* payload, flip SECRETS_ADAPTER=gcp + GCP_PROJECT_ID, and
    // assert the loader-provided adapter returns the mocked test key.
    // NEVER hit a real GCP project; NEVER use production data.
    expect(true).toBe(true)
  })
})
