#!/usr/bin/env node
/**
 * Story v160-8-6: Ed25519 signature verification CLI for gp-config artifacts.
 *
 * Usage:
 *   pnpm tsx packages/api/src/scripts/verify-gp-config-signature.ts [artifact_path]
 *
 * Env:
 *   GP_CONFIG_VERIFY_PUBKEY  - hex/base64 Ed25519 public key
 *   GP_CONFIG_ARTIFACT_PATH  - default artifact path (override via CLI arg)
 *
 * Exit codes:
 *   0 = PASS (signature verified)
 *   1 = FAIL (missing/invalid signature)
 *   2 = SKIP (no pubkey configured / DEFER)
 *
 * @see specs/operator/security-gates-checklist.md
 */

/* eslint-disable no-console */

import * as fs from "node:fs"
import * as path from "node:path"

type Evidence = {
  artifact_path: string
  signature_status: "pass" | "fail" | "skip"
  signed_at: string | null
  signer_kid: string | null
  reason?: string
}

function emit(ev: Evidence, exitCode: number): never {
  process.stdout.write(JSON.stringify(ev, null, 2) + "\n")
  process.exit(exitCode)
}

async function main(): Promise<void> {
  const artifactArg = process.argv[2]
  const artifactPath =
    artifactArg ||
    process.env.GP_CONFIG_ARTIFACT_PATH ||
    path.resolve(process.cwd(), "../../../../gp-ops/config/dist/gp-config.json")

  const pubkey = process.env.GP_CONFIG_VERIFY_PUBKEY
  if (!pubkey) {
    emit(
      {
        artifact_path: artifactPath,
        signature_status: "skip",
        signed_at: null,
        signer_kid: null,
        reason: "GP_CONFIG_VERIFY_PUBKEY not set (DEFER until signing infra active)",
      },
      2,
    )
  }

  if (!fs.existsSync(artifactPath)) {
    emit(
      {
        artifact_path: artifactPath,
        signature_status: "skip",
        signed_at: null,
        signer_kid: null,
        reason: "Artifact not found (DEFER until materialization)",
      },
      2,
    )
  }

  const sigPath = artifactPath + ".sig"
  if (!fs.existsSync(sigPath)) {
    emit(
      {
        artifact_path: artifactPath,
        signature_status: "fail",
        signed_at: null,
        signer_kid: null,
        reason: "Signature file (.sig) missing",
      },
      1,
    )
  }

  // Try noble-ed25519 if available; fallback to skip.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ed = (await (
      Function("return import('@noble/ed25519')") as () => Promise<unknown>
    )().catch(() => null)) as {
      verify: (s: Uint8Array, m: Uint8Array, p: Uint8Array) => Promise<boolean>
    } | null
    if (!ed) {
      emit(
        {
          artifact_path: artifactPath,
          signature_status: "skip",
          signed_at: null,
          signer_kid: null,
          reason: "@noble/ed25519 not installed (DEFER — install in Sprint 0/1 signing activation)",
        },
        2,
      )
    }
    const data = fs.readFileSync(artifactPath)
    const sig = fs.readFileSync(sigPath)
    const pk =
      pubkey!.length === 64
        ? Uint8Array.from(Buffer.from(pubkey!, "hex"))
        : Uint8Array.from(Buffer.from(pubkey!, "base64"))
    const ok: boolean = await ed.verify(sig, data, pk)
    const stat = fs.statSync(artifactPath)
    emit(
      {
        artifact_path: artifactPath,
        signature_status: ok ? "pass" : "fail",
        signed_at: stat.mtime.toISOString(),
        signer_kid: pubkey!.slice(0, 16) + "…",
      },
      ok ? 0 : 1,
    )
  } catch (err) {
    emit(
      {
        artifact_path: artifactPath,
        signature_status: "fail",
        signed_at: null,
        signer_kid: null,
        reason: `verify error: ${(err as Error).message}`,
      },
      1,
    )
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
