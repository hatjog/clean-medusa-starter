#!/usr/bin/env node
/**
 * GP-config artifact Ed25519 signature verification CLI.
 *
 * This script is a fail-closed signing gate. It exits with code 1 (FAIL) unless
 * the artifact signature is cryptographically valid. There is no silent "skip"
 * unless GP_CONFIG_SIGNING_ALLOW_SKIP=1 is explicitly set for local development.
 *
 * Usage:
 *   pnpm tsx packages/api/src/scripts/verify-gp-config-signature.ts [artifact_path]
 *
 * Env:
 *   GP_CONFIG_SIGNING_PUBKEY   - Ed25519 public key: PEM block or hex-encoded raw 32-byte key (primary)
 *   GP_CONFIG_VERIFY_PUBKEY    - DEPRECATED: hex/base64 Ed25519 public key (fallback, remove in v1.7.0)
 *   GP_CONFIG_ARTIFACT_PATH    - default artifact path (override via CLI arg)
 *   GP_CONFIG_SIGNING_ALLOW_SKIP - set to "1" to restore skip behavior for local dev (NOT for production)
 *
 * Exit codes:
 *   0 = PASS (signature verified)
 *   1 = FAIL (missing pubkey / missing artifact / invalid signature)
 *   2 = SKIP (only when GP_CONFIG_SIGNING_ALLOW_SKIP=1; not a valid production state)
 *
 * @see specs/operator/security-gates-checklist.md
 * @see _bmad-output/operator-runbooks/gp-config-signing-key-rotation.md
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

  const allowSkip = process.env.GP_CONFIG_SIGNING_ALLOW_SKIP === "1"
  if (allowSkip) {
    process.stderr.write(
      "[gp-config-verify] WARNING: GP_CONFIG_SIGNING_ALLOW_SKIP=1 is honored — verification may be SKIPPED. Local dev only; never set in production.\n",
    )
  }

  // AC2: Load pubkey from GP_CONFIG_SIGNING_PUBKEY (primary).
  // Fallback to GP_CONFIG_VERIFY_PUBKEY (deprecated) with deprecation notice.
  // Final fallback: default dist pubkey file at gp-ops/config/dist/gp-config.pub.
  let pubkey: string | null = process.env.GP_CONFIG_SIGNING_PUBKEY || null

  if (!pubkey && process.env.GP_CONFIG_VERIFY_PUBKEY) {
    process.stderr.write(
      "[gp-config-verify] DEPRECATION: GP_CONFIG_VERIFY_PUBKEY is deprecated; use GP_CONFIG_SIGNING_PUBKEY instead (removal: v1.7.0)\n",
    )
    pubkey = process.env.GP_CONFIG_VERIFY_PUBKEY
  }

  const defaultPubkeyPath = path.join(defaultDistDir, "gp-config.pub")
  if (!pubkey && fs.existsSync(defaultPubkeyPath)) {
    pubkey = fs.readFileSync(defaultPubkeyPath, "utf8").trim()
  }

  // AC4: Fail-closed when no pubkey is configured.
  if (!pubkey) {
    if (allowSkip) {
      emit(
        {
          artifact_path: artifactPath,
          signature_status: "skip",
          signed_at: null,
          signer_kid: null,
          reason: "ALLOW_SKIP override (local dev only — not a valid production state)",
        },
        2,
      )
    }
    emit(
      {
        artifact_path: artifactPath,
        signature_status: "fail",
        signed_at: null,
        signer_kid: null,
        reason: "no signing pubkey configured (GP_CONFIG_SIGNING_PUBKEY unset and default dist pubkey missing)",
      },
      1,
    )
  }

  // AC4: Fail-closed when artifact is not found.
  if (!fs.existsSync(artifactPath)) {
    if (allowSkip) {
      emit(
        {
          artifact_path: artifactPath,
          signature_status: "skip",
          signed_at: null,
          signer_kid: null,
          reason: "ALLOW_SKIP override — artifact not found (local dev only)",
        },
        2,
      )
    }
    emit(
      {
        artifact_path: artifactPath,
        signature_status: "fail",
        signed_at: null,
        signer_kid: null,
        reason: "artifact not found",
      },
      1,
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
        reason: "signature file (.sig) missing",
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
