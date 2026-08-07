/**
 * vendor-secret/crypto-core — per-vendor HMAC secret resolver (ADR-182, ADR-156 §1/§4/§6a).
 *
 * WHY THIS LIVES HERE (ADR-182 decision, AC3):
 *   `GP/backend` is a separate git submodule with its OWN pnpm workspace
 *   (`packages/*`). `gp-ops/cli` (`@gp-ops/cli`, `private: true`) belongs to the
 *   SUPERPROJECT workspace and is never published to a registry. There is no
 *   relative path across the submodule boundary in a backend checkout, so the
 *   backend CANNOT import a crypto-core from gp-ops. The crypto-core therefore
 *   lives on the backend side, and gp-ops keeps custody + topology + isolation
 *   assertion. Parity carrier: `_grow/tools/validate_vendor_secret_dual_window.py`
 *   plus the shared contracts under `specs/contracts/`.
 *
 * WHAT IT DOES:
 *   - decrypt-on-boot (ADR-156 §4): the SOPS-encrypted vendor secret-set is
 *     decrypted ONCE per process into an in-memory map. There is NO shell-out
 *     per request.
 *   - `config_ref` → secret value: the secret-set maps `seller_id → config_ref`
 *     and `config_ref → secret material`. Resolution for a request is
 *     `sellerId → config_ref → Buffer`.
 *   - failure taxonomy (ADR-156 §6a, ADR-182): a broken/absent age key or a
 *     failed decrypt is a STORE-level fault (operator problem → HTTP 503 on
 *     `/vendor/*`, rest of the API stays alive); a healthy store that simply has
 *     no entry for this seller is an AUTHENTICATION outcome (HTTP 401).
 *
 * NON-NEGOTIABLES:
 *   - This module NEVER reads a shared secret. There is no fallback branch, not
 *     even behind a flag (AD-20). Enforced by
 *     `_grow/tools/validate_vendor_secret_dual_window.py`.
 *   - No secret material — not the value, not a prefix, not a length-bearing
 *     substring — is ever put into an error message or a log line
 *     (`specs/constitution/secrets-nonnegotiables.md` invariant 1). Decryptor
 *     stdout/stderr is NEVER echoed: it may contain plaintext.
 *
 * @module vendor-secret/crypto-core
 */
import { spawnSync } from "child_process"

/**
 * Store-level fault: crypto-core itself is unusable (age key absent/broken,
 * decrypt failed, secret-set malformed). Maps to HTTP 503 on `/vendor/*`.
 * MUST stay distinguishable from `VENDOR_AUTH_SECRET_NOT_PROVISIONED`.
 */
export const VENDOR_AUTH_SECRET_STORE_UNAVAILABLE =
  "VENDOR_AUTH_SECRET_STORE_UNAVAILABLE" as const

/**
 * Authentication outcome: crypto-core is healthy, but this seller has no
 * per-vendor secret. Maps to HTTP 401. The HTTP body deliberately does NOT
 * carry this code (AC5 non-disclosure — see vendor-auth.ts); the code is the
 * server-side, log-visible discriminator required by AC1.
 */
export const VENDOR_AUTH_SECRET_NOT_PROVISIONED =
  "VENDOR_AUTH_SECRET_NOT_PROVISIONED" as const

/** Env var naming the SOPS-encrypted vendor secret-set. */
export const VENDOR_SECRET_SET_PATH_ENV = "VENDOR_SECRET_SET_PATH"

/**
 * Reason classes for a store-level fault. Deliberately coarse: a reason is a
 * CLASS, never a payload. Nothing derived from decryptor output is included.
 */
export type CryptoCoreFaultReason =
  | "secret-set-path-unset"
  | "decryptor-unavailable"
  | "decrypt-failed"
  | "secret-set-malformed"

export type CryptoCoreHealth =
  | { healthy: true }
  | { healthy: false; reason: CryptoCoreFaultReason }

/**
 * Decrypts the secret-set at `path` and returns its PLAINTEXT. Injectable so
 * tests exercise the core without a `sops` binary and without real key material.
 * Implementations MUST throw on any failure — a partial/empty read is a fault,
 * never an empty secret-set.
 */
export type SecretSetDecryptor = (path: string) => string

type SecretSetEntry = {
  seller_id: string
  config_ref: string
  /** base64-encoded HMAC secret material. */
  secret_b64: string
}

/**
 * Default decryptor: `sops -d --output-type json <path>`, executed ONCE at boot.
 * Custody of the private age key is `SOPS_AGE_KEY_FILE` (gp-ops SetupService).
 * stdout/stderr are never surfaced — stdout IS the plaintext.
 */
export const sopsDecryptor: SecretSetDecryptor = (path: string): string => {
  let proc: ReturnType<typeof spawnSync>
  try {
    proc = spawnSync("sops", ["-d", "--output-type", "json", path], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    })
  } catch {
    throw new CryptoCoreFault("decryptor-unavailable")
  }

  if (proc.error || proc.status === null) {
    // ENOENT on the `sops` binary lands here.
    throw new CryptoCoreFault("decryptor-unavailable")
  }
  if (proc.status !== 0) {
    // Missing/incorrect age key, no matching recipient stanza, unreadable file.
    throw new CryptoCoreFault("decrypt-failed")
  }
  const out = typeof proc.stdout === "string" ? proc.stdout : ""
  if (!out) {
    throw new CryptoCoreFault("decrypt-failed")
  }
  return out
}

/** Carries a reason CLASS only. The message never contains secret material. */
export class CryptoCoreFault extends Error {
  readonly code = VENDOR_AUTH_SECRET_STORE_UNAVAILABLE
  readonly reason: CryptoCoreFaultReason

  constructor(reason: CryptoCoreFaultReason) {
    super(`vendor secret store unavailable (${reason})`)
    this.name = "CryptoCoreFault"
    this.reason = reason
  }
}

function parseSecretSet(plaintext: string): Map<string, { ref: string; secret: Buffer }> {
  let doc: unknown
  try {
    doc = JSON.parse(plaintext)
  } catch {
    throw new CryptoCoreFault("secret-set-malformed")
  }

  const entries = (doc as { entries?: unknown } | null)?.entries
  if (!Array.isArray(entries)) {
    throw new CryptoCoreFault("secret-set-malformed")
  }

  const bySeller = new Map<string, { ref: string; secret: Buffer }>()
  for (const raw of entries) {
    const e = raw as Partial<SecretSetEntry> | null
    if (
      !e ||
      typeof e.seller_id !== "string" ||
      typeof e.config_ref !== "string" ||
      typeof e.secret_b64 !== "string" ||
      !e.seller_id ||
      !e.config_ref ||
      !e.secret_b64
    ) {
      throw new CryptoCoreFault("secret-set-malformed")
    }
    const secret = Buffer.from(e.secret_b64, "base64")
    if (secret.length === 0) {
      throw new CryptoCoreFault("secret-set-malformed")
    }
    bySeller.set(e.seller_id, { ref: e.config_ref, secret })
  }
  return bySeller
}

/**
 * In-memory per-vendor secret resolver. Built once (decrypt-on-boot), then
 * queried per request without any I/O.
 */
export class VendorSecretCryptoCore {
  private readonly bySeller: Map<string, { ref: string; secret: Buffer }>
  private readonly byRef: Map<string, Buffer>

  private constructor(bySeller: Map<string, { ref: string; secret: Buffer }>) {
    this.bySeller = bySeller
    this.byRef = new Map()
    for (const { ref, secret } of bySeller.values()) {
      this.byRef.set(ref, secret)
    }
  }

  /**
   * Decrypt-on-boot. Throws {@link CryptoCoreFault} on any store-level fault —
   * the caller turns that into a 503 on `/vendor/*` only (graceful degradation,
   * P6-5b): the rest of the API is untouched because nothing else calls this.
   */
  static load(opts?: {
    secretSetPath?: string
    decryptor?: SecretSetDecryptor
  }): VendorSecretCryptoCore {
    const path = opts?.secretSetPath ?? process.env[VENDOR_SECRET_SET_PATH_ENV] ?? ""
    if (!path) {
      throw new CryptoCoreFault("secret-set-path-unset")
    }
    const decryptor = opts?.decryptor ?? sopsDecryptor
    let plaintext: string
    try {
      plaintext = decryptor(path)
    } catch (err) {
      // Reason class is preserved when the decryptor already classified it;
      // anything else collapses to `decrypt-failed`. The original error is
      // NEVER re-thrown or stringified — it may carry plaintext.
      throw err instanceof CryptoCoreFault ? err : new CryptoCoreFault("decrypt-failed")
    }
    return new VendorSecretCryptoCore(parseSecretSet(plaintext))
  }

  /** `config_ref` → secret material (ADR-156 §1). */
  resolveByConfigRef(configRef: string): Buffer | null {
    return this.byRef.get(configRef) ?? null
  }

  /** `seller_id` → `config_ref` → secret material. `null` = not provisioned. */
  resolveForSeller(sellerId: string): Buffer | null {
    const entry = this.bySeller.get(sellerId)
    if (!entry) return null
    return this.resolveByConfigRef(entry.ref)
  }

  /** `config_ref` for a seller, for `verify-all` manifests. Never the value. */
  configRefForSeller(sellerId: string): string | null {
    return this.bySeller.get(sellerId)?.ref ?? null
  }

  get provisionedCount(): number {
    return this.bySeller.size
  }
}

// ---------------------------------------------------------------------------
// Process-wide singleton — decrypt happens ONCE, not per request (ADR-156 §4).
// ---------------------------------------------------------------------------
type CoreState =
  | { kind: "unloaded" }
  | { kind: "ready"; core: VendorSecretCryptoCore }
  | { kind: "faulted"; fault: CryptoCoreFault; retryAt: number | null }

/**
 * Fault reasons whose cause CANNOT change without an operator edit + redeploy:
 * caching them forever is correct (no shell-out storm on a misconfigured env).
 * Everything else — `sops` briefly missing from PATH during a rolling deploy, a
 * secret-set volume not yet mounted when the first request lands — is TRANSIENT
 * and MUST NOT escalate to a permanent `503` on all of `/vendor/*` until the
 * process is restarted (review-fix M-4).
 */
const DETERMINISTIC_FAULTS: ReadonlySet<CryptoCoreFaultReason> = new Set<CryptoCoreFaultReason>([
  "secret-set-path-unset",
  "secret-set-malformed",
])

/** Backoff before a transient fault is re-attempted. */
export const CRYPTO_CORE_FAULT_RETRY_MS = 5_000

let _state: CoreState = { kind: "unloaded" }
let _defaults: { secretSetPath?: string; decryptor?: SecretSetDecryptor } = {}
let _clock: () => number = () => Date.now()

/** Visible for testing: makes the transient-fault backoff measurable. */
export function setVendorSecretCryptoCoreClockForTests(clock: (() => number) | null): void {
  _clock = clock ?? (() => Date.now())
}

/**
 * Sets the boot options used when the core is booted without explicit options
 * (request path, boot loader, tests). Resets any previously booted state so the
 * next resolution re-decrypts under the new options.
 */
export function configureVendorSecretCryptoCore(opts: {
  secretSetPath?: string
  decryptor?: SecretSetDecryptor
}): void {
  _defaults = { ...opts }
  _state = { kind: "unloaded" }
}

/**
 * Returns the booted crypto-core, or a store-level fault.
 *
 * Fault caching is DELIBERATELY asymmetric (review-fix M-4):
 *   - a DETERMINISTIC fault (`secret-set-path-unset`, `secret-set-malformed`)
 *     is cached until {@link resetVendorSecretCryptoCore} — retrying a
 *     misconfigured env on every request buys nothing;
 *   - a TRANSIENT fault (`decryptor-unavailable`, `decrypt-failed`) is cached
 *     only for {@link CRYPTO_CORE_FAULT_RETRY_MS}, after which the next call
 *     re-attempts the decrypt. Without this, one blip (sops missing from PATH
 *     mid-deploy, volume not yet mounted) turned a momentary outage into a
 *     permanent `503` on all of `/vendor/*` until the process restarted.
 *
 * The retry is bounded by the backoff, so this is still not a shell-out per
 * request.
 */
export function getVendorSecretCryptoCore(opts?: {
  secretSetPath?: string
  decryptor?: SecretSetDecryptor
}): { ok: true; core: VendorSecretCryptoCore } | { ok: false; fault: CryptoCoreFault } {
  const now = _clock()
  const retryDue =
    _state.kind === "faulted" && _state.retryAt !== null && now >= _state.retryAt

  if (_state.kind === "unloaded" || retryDue) {
    try {
      _state = { kind: "ready", core: VendorSecretCryptoCore.load(opts ?? _defaults) }
    } catch (err) {
      const fault =
        err instanceof CryptoCoreFault ? err : new CryptoCoreFault("decrypt-failed")
      _state = {
        kind: "faulted",
        fault,
        retryAt: DETERMINISTIC_FAULTS.has(fault.reason)
          ? null
          : now + CRYPTO_CORE_FAULT_RETRY_MS,
      }
    }
  }
  return _state.kind === "ready"
    ? { ok: true, core: _state.core }
    : { ok: false, fault: (_state as { fault: CryptoCoreFault }).fault }
}

/** Boot health-check, distinguishable from per-vendor resolve (ADR-156 §6a). */
export function vendorSecretCryptoCoreHealth(opts?: {
  secretSetPath?: string
  decryptor?: SecretSetDecryptor
}): CryptoCoreHealth {
  const r = getVendorSecretCryptoCore(opts)
  return r.ok ? { healthy: true } : { healthy: false, reason: r.fault.reason }
}

/** Visible for testing and for post-custody-fix re-boot. */
export function resetVendorSecretCryptoCore(): void {
  _state = { kind: "unloaded" }
  _defaults = {}
  _clock = () => Date.now()
}
