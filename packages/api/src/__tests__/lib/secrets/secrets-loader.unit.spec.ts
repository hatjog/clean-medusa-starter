// AC5 import isolation is exercised here: the loader only pulls gcp-adapter
// (and @google-cloud/secret-manager) via a dynamic import in the `gcp` branch.
// We mock the SDK so the gcp branch is testable without real GCP.
jest.mock("@google-cloud/secret-manager", () => ({
  SecretManagerServiceClient: jest.fn().mockImplementation(() => ({
    accessSecretVersion: jest.fn(),
  })),
}))

import secretsLoader from "../../../loaders/secrets"
import { EnvSecretsAdapter } from "../../../lib/secrets/env-adapter"
// Static import is safe in the TEST: @google-cloud/secret-manager is jest-mocked
// above. AC5 import isolation governs the production env-runtime path, not tests.
import { GcpSecretsAdapter } from "../../../lib/secrets/gcp-adapter"

type Registered = { secretsAdapter?: unknown }

function makeContainer() {
  const store: Registered = {}
  const container = {
    register: jest.fn((key: string, resolver: { resolve: () => unknown }) => {
      // asValue(x) → { resolve: () => x } shape in awilix; capture the value.
      store[key as keyof Registered] = resolver.resolve
        ? resolver.resolve()
        : (resolver as unknown)
    }),
  }
  return { container, store }
}

describe("secretsLoader — adapter selection (Story 1.2 AC3/AC10)", () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
    jest.clearAllMocks()
  })

  afterAll(() => {
    process.env = originalEnv
  })

  it("defaults to EnvSecretsAdapter when SECRETS_ADAPTER is unset", async () => {
    delete process.env.SECRETS_ADAPTER
    const { container, store } = makeContainer()
    await secretsLoader({ container: container as never })
    expect(container.register).toHaveBeenCalledWith(
      "secretsAdapter",
      expect.anything()
    )
    expect(store.secretsAdapter).toBeInstanceOf(EnvSecretsAdapter)
  })

  it("registers EnvSecretsAdapter for SECRETS_ADAPTER=env (explicit)", async () => {
    process.env.SECRETS_ADAPTER = "env"
    const { container, store } = makeContainer()
    await secretsLoader({ container: container as never })
    expect(store.secretsAdapter).toBeInstanceOf(EnvSecretsAdapter)
  })

  it("registers GcpSecretsAdapter for SECRETS_ADAPTER=gcp", async () => {
    process.env.SECRETS_ADAPTER = "gcp"
    process.env.GCP_PROJECT_ID = "test-project"
    const { container, store } = makeContainer()
    await secretsLoader({ container: container as never })
    expect(store.secretsAdapter).toBeInstanceOf(GcpSecretsAdapter)
  })

  it("fail-fast (throws) on unknown SECRETS_ADAPTER — no silent fallback", async () => {
    process.env.SECRETS_ADAPTER = "vault"
    const { container } = makeContainer()
    await expect(
      secretsLoader({ container: container as never })
    ).rejects.toThrow(/Invalid SECRETS_ADAPTER/)
    expect(container.register).not.toHaveBeenCalled()
  })

  it("registers the adapter as a single shared instance (singleton)", async () => {
    delete process.env.SECRETS_ADAPTER
    const { container, store } = makeContainer()
    await secretsLoader({ container: container as never })
    const first = store.secretsAdapter
    expect(container.register).toHaveBeenCalledTimes(1)
    expect(first).toBe(store.secretsAdapter)
  })
})
