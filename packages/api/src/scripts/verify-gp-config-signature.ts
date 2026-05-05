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

import {
  buildPublicKeyKid,
  verifyEd25519Signature,
} from "../lib/gp-config-signing"

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
  const defaultDistDir = path.resolve(process.cwd(), "../../gp-ops/config/dist")
  const artifactPath =
    artifactArg ||
    process.env.GP_CONFIG_ARTIFACT_PATH ||
    path.join(defaultDistDir, "gp-config.json")

  const pubkey = process.env.GP_CONFIG_VERIFY_PUBKEY ||
    (fs.existsSync(path.join(defaultDistDir, "gp-config.pub"))
      ? fs.readFileSync(path.join(defaultDistDir, "gp-config.pub"), "utf8").trim()
      : null)
  if (!pubkey) {
    emit(
      {
        artifact_path: artifactPath,
        signature_status: "skip",
        signed_at: null,
        signer_kid: null,
        reason: "GP_CONFIG_VERIFY_PUBKEY not set and default dist pubkey missing (DEFER until signing infra active)",
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

  try {
    const data = fs.readFileSync(artifactPath)
    const sig = fs.readFileSync(sigPath)
    const ok = verifyEd25519Signature(data, sig, pubkey!)
    const stat = fs.statSync(artifactPath)
    emit(
      {
        artifact_path: artifactPath,
        signature_status: ok ? "pass" : "fail",
        signed_at: stat.mtime.toISOString(),
        signer_kid: buildPublicKeyKid(pubkey!),
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
