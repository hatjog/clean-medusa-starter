import type { MedusaContainer } from "@medusajs/types"
import { asValue } from "awilix"
import { EnvSecretsAdapter } from "../lib/secrets/env-adapter"
import type { SecretsAdapter } from "../lib/secrets/index"
// Type-only import: fully erased at compile time, so it does NOT pull
// @google-cloud/secret-manager into the env-runtime module graph (AC5).
import type { GcpSecretsAdapter as GcpSecretsAdapterCtor } from "../lib/secrets/gcp-adapter"

/**
 * AC3 — Reads process.env.SECRETS_ADAPTER ("env" | "gcp"; default "env" when
 * unset) and registers the chosen SecretsAdapter instance as an Awilix
 * singleton under the stable container key `secretsAdapter`. An unknown value
 * is a fail-fast at startup — never a silent fallback.
 */
const VALID_ADAPTERS = ["env", "gcp"] as const
type AdapterKind = (typeof VALID_ADAPTERS)[number]

export default async function secretsLoader({
  container,
}: {
  container: MedusaContainer
}): Promise<void> {
  const raw = process.env.SECRETS_ADAPTER ?? "env"

  if (!VALID_ADAPTERS.includes(raw as AdapterKind)) {
    // AC3 — fail-fast, readable, no silent fallback. Lists allowed values;
    // never echoes other env values.
    throw new Error(
      `Invalid SECRETS_ADAPTER="${raw}". Expected one of: ${VALID_ADAPTERS.join(
        ", "
      )}.`
    )
  }
  const kind = raw as AdapterKind

  // AC8 / F16 — v1.10.0+ production allowlist.
  // In v1.10.0+ the env adapter MUST be refused in production (live Stripe
  // keys may never live on the filesystem — F14). v1.8.0 ships the stub gated
  // behind NODE_ENV !== 'production': in v1.8.0 the env adapter in production
  // does NOT block, but the refusal point is present and readable for the
  // v1.10.0 owner to flip.
  // F16 — flip w v1.10.0: remove the leading `false && ` from the guard
  // below so production + SECRETS_ADAPTER=env is rejected unconditionally.
  // eslint-disable-next-line no-constant-condition
  if (false && process.env.NODE_ENV === "production" && kind === "env") {
    throw new Error(
      "SECRETS_ADAPTER=env is not permitted in production from v1.10.0 (F16/F14). Use SECRETS_ADAPTER=gcp."
    )
  }

  let adapter: SecretsAdapter
  if (kind === "gcp") {
    // AC5 — Import isolation: gcp-adapter (and the @google-cloud/secret-manager
    // devDependency it pulls in) is loaded ONLY here, lazily, inside the `gcp`
    // branch via require(). It never enters the module graph when
    // SECRETS_ADAPTER=env. (CJS lazy require, not dynamic import(): this
    // backend compiles as CJS under module:Node16, where a relative dynamic
    // import() would require a .js specifier that the jest/SWC resolver does
    // not map back to .ts — require() is the correct, isolation-equivalent
    // primitive here.)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { GcpSecretsAdapter } = require("../lib/secrets/gcp-adapter") as {
      GcpSecretsAdapter: typeof GcpSecretsAdapterCtor
    }
    adapter = new GcpSecretsAdapter()
  } else {
    adapter = new EnvSecretsAdapter()
  }

  // Awilix singleton (asValue → same instance for the container lifetime).
  container.register("secretsAdapter", asValue(adapter))
}
