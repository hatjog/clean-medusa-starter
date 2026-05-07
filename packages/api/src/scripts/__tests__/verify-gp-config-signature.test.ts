/**
 * Tests for verify-gp-config-signature.ts (AC5: a-e)
 * Story v160-cleanup-49: gp-config Ed25519 signing infra activation
 *
 * Uses child_process.spawnSync to execute the CLI as a subprocess, avoiding
 * dynamic-import / process.exit mocking complexity.
 *
 * All keypairs generated at test setup time via Node crypto — NO production keys committed.
 */

import * as crypto from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import * as childProcess from "node:child_process"

import { afterAll, beforeAll, describe, expect, it } from "@jest/globals"

// ---------------------------------------------------------------------------
// Keypair fixture — generated once per test run via Node crypto (STAGING-FREE)
// ---------------------------------------------------------------------------
let privKey: crypto.KeyObject
let pubKey: crypto.KeyObject
let pubKeyHex: string
let pubKeyPem: string
let tmpDir: string

const ARTIFACT_CONTENT = Buffer.from('{"market":"test","version":"1.0.0"}')

// Path to the CLI script and backend root (resolved from this test file's location:
// packages/api/src/scripts/__tests__ → up 5 levels → GP/backend root)
const BACKEND_ROOT = path.resolve(__dirname, "../../../../..")
const CLI_SCRIPT = path.resolve(__dirname, "..", "verify-gp-config-signature.ts")

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gp-verify-test-"))
  const kp = crypto.generateKeyPairSync("ed25519")
  privKey = kp.privateKey
  pubKey = kp.publicKey
  const der = pubKey.export({ format: "der", type: "spki" }) as Buffer
  pubKeyHex = der.subarray(der.length - 32).toString("hex")
  pubKeyPem = pubKey.export({ format: "pem", type: "spki" }) as string
})

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Helper: write artifact + sig to tmpdir
// ---------------------------------------------------------------------------
function signArtifact(artifact: Buffer): Buffer {
  return crypto.sign(null, artifact, privKey) as Buffer
}

async function writeArtifactAndSig(
  filename: string,
  artifact: Buffer,
  sig: Buffer | null,
): Promise<string> {
  const artifactPath = path.join(tmpDir, filename)
  await fs.writeFile(artifactPath, artifact)
  if (sig !== null) {
    await fs.writeFile(artifactPath + ".sig", sig)
  }
  return artifactPath
}

/**
 * Run the verifier CLI via tsx as a subprocess.
 * Returns parsed JSON output and exit code.
 */
function runVerifierCLI(
  artifactPath: string,
  envOverrides: Record<string, string | undefined> = {},
  cwdOverride?: string,
): { output: string; exitCode: number } {
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    // Unset defaults that could interfere
    GP_CONFIG_SIGNING_PUBKEY: "",
    GP_CONFIG_VERIFY_PUBKEY: "",
    GP_CONFIG_SIGNING_ALLOW_SKIP: "",
    // Defense-in-depth: scrub any operator-set artifact path so the test always
    // exercises the explicit artifactPath argument we pass below.
    GP_CONFIG_ARTIFACT_PATH: "",
  }

  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined || v === "") {
      delete env[k]
    } else {
      env[k] = v
    }
  }

  // Remove empty string values
  for (const k of Object.keys(env)) {
    if (env[k] === "") delete env[k]
  }

  const result = childProcess.spawnSync(
    "npx",
    ["tsx", CLI_SCRIPT, artifactPath],
    {
      env,
      encoding: "utf8",
      timeout: 15000,
      cwd: cwdOverride || BACKEND_ROOT,
    },
  )

  return {
    output: result.stdout || "",
    exitCode: result.status ?? 1,
  }
}

// ---------------------------------------------------------------------------
// AC5(a): Valid signature → pass, exit 0
// ---------------------------------------------------------------------------
describe("AC5(a): valid signature pass", () => {
  it("emits signature_status: pass and exits 0 for hex pubkey + valid sig", async () => {
    const sig = signArtifact(ARTIFACT_CONTENT)
    const artifactPath = await writeArtifactAndSig("valid-hex.json", ARTIFACT_CONTENT, sig)

    const { output, exitCode } = runVerifierCLI(artifactPath, {
      GP_CONFIG_SIGNING_PUBKEY: pubKeyHex,
    })

    const evidence = JSON.parse(output.trim())
    expect(evidence.signature_status).toBe("pass")
    expect(exitCode).toBe(0)
  })

  // F6: AC2/AC5(f) coverage at the CLI subprocess level — operator workflow uses
  // PEM via env var (openssl pkey -pubout output is PEM by default).
  it("emits signature_status: pass and exits 0 for PEM pubkey + valid sig", async () => {
    const sig = signArtifact(ARTIFACT_CONTENT)
    const artifactPath = await writeArtifactAndSig("valid-pem.json", ARTIFACT_CONTENT, sig)

    const { output, exitCode } = runVerifierCLI(artifactPath, {
      GP_CONFIG_SIGNING_PUBKEY: pubKeyPem,
    })

    const evidence = JSON.parse(output.trim())
    expect(evidence.signature_status).toBe("pass")
    expect(exitCode).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// AC5(b): Invalid signature → fail, exit 1
// ---------------------------------------------------------------------------
describe("AC5(b): invalid signature fail", () => {
  it("exits 1 when artifact bytes are tampered", async () => {
    const sig = signArtifact(ARTIFACT_CONTENT)
    const tampered = Buffer.concat([ARTIFACT_CONTENT, Buffer.from(" tampered")])
    const artifactPath = await writeArtifactAndSig("tampered-artifact.json", tampered, sig)

    const { output, exitCode } = runVerifierCLI(artifactPath, {
      GP_CONFIG_SIGNING_PUBKEY: pubKeyHex,
    })

    const evidence = JSON.parse(output.trim())
    expect(evidence.signature_status).toBe("fail")
    expect(exitCode).toBe(1)
  })

  it("exits 1 when signature bytes are tampered", async () => {
    const sig = signArtifact(ARTIFACT_CONTENT)
    const tamperedSig = Buffer.from(sig)
    tamperedSig[0] = tamperedSig[0] ^ 0xff
    const artifactPath = await writeArtifactAndSig("tampered-sig.json", ARTIFACT_CONTENT, tamperedSig)

    const { output, exitCode } = runVerifierCLI(artifactPath, {
      GP_CONFIG_SIGNING_PUBKEY: pubKeyHex,
    })

    const evidence = JSON.parse(output.trim())
    expect(evidence.signature_status).toBe("fail")
    expect(exitCode).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// AC5(c): Missing pubkey → fail-closed, exit 1
// ---------------------------------------------------------------------------
describe("AC5(c): missing pubkey → fail-closed", () => {
  it("exits 1 with 'no signing pubkey configured' when no key env vars set", async () => {
    const sig = signArtifact(ARTIFACT_CONTENT)
    const artifactPath = await writeArtifactAndSig("no-pubkey.json", ARTIFACT_CONTENT, sig)

    // Use tmpDir as cwd so the default dist path (../../gp-ops/config/dist/gp-config.pub)
    // does not resolve to an existing file — ensuring the "no pubkey" branch is hit.
    const { output, exitCode } = runVerifierCLI(
      artifactPath,
      {
        GP_CONFIG_SIGNING_PUBKEY: undefined,
        GP_CONFIG_VERIFY_PUBKEY: undefined,
      },
      tmpDir, // cwd where ../../gp-ops/config/dist/gp-config.pub won't exist
    )

    const evidence = JSON.parse(output.trim())
    expect(evidence.signature_status).toBe("fail")
    expect(exitCode).toBe(1)
    expect(evidence.reason).toContain("no signing pubkey configured")
  })
})

// ---------------------------------------------------------------------------
// AC5(d): Missing artifact → fail-closed, exit 1
// ---------------------------------------------------------------------------
describe("AC5(d): missing artifact → fail-closed", () => {
  it("exits 1 with 'artifact not found' when artifact path does not exist", async () => {
    const missingPath = path.join(tmpDir, "does-not-exist-ac5d.json")
    // Create .sig so we pass that check
    await fs.writeFile(missingPath + ".sig", Buffer.alloc(64))

    const { output, exitCode } = runVerifierCLI(missingPath, {
      GP_CONFIG_SIGNING_PUBKEY: pubKeyHex,
    })

    const evidence = JSON.parse(output.trim())
    expect(evidence.signature_status).toBe("fail")
    expect(exitCode).toBe(1)
    expect(evidence.reason).toContain("artifact not found")
  })
})

// ---------------------------------------------------------------------------
// AC5(e): Missing signature file → fail-closed, exit 1
// ---------------------------------------------------------------------------
describe("AC5(e): missing signature file → fail-closed", () => {
  it("exits 1 with 'signature file (.sig) missing' when .sig is absent", async () => {
    const artifactPath = path.join(tmpDir, "no-sig-file.json")
    await fs.writeFile(artifactPath, ARTIFACT_CONTENT)
    // Intentionally do NOT create the .sig file

    const { output, exitCode } = runVerifierCLI(artifactPath, {
      GP_CONFIG_SIGNING_PUBKEY: pubKeyHex,
    })

    const evidence = JSON.parse(output.trim())
    expect(evidence.signature_status).toBe("fail")
    expect(exitCode).toBe(1)
    expect(evidence.reason).toContain("signature file (.sig) missing")
  })
})
