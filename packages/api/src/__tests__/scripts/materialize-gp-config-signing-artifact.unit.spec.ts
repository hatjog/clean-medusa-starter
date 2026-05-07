import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { describe, expect, it } from "@jest/globals"

import { verifyEd25519Signature } from "../../lib/gp-config-signing"
import { materializeGpConfigSigningArtifact } from "../../scripts/materialize-gp-config-signing-artifact"

describe("materializeGpConfigSigningArtifact", () => {
  it("writes a signed artifact, public key, and verifier fixture", async () => {
    const configRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gp-config-root-"))
    const instanceRoot = path.join(configRoot, "gp-dev")

    await fs.mkdir(path.join(instanceRoot, "markets", "bonbeauty"), {
      recursive: true,
    })
    await fs.mkdir(path.join(instanceRoot, "markets", "mercur"), {
      recursive: true,
    })
    await fs.writeFile(
      path.join(instanceRoot, "instance.yaml"),
      [
        "instance_id: gp-dev",
        "markets:",
        "  - market_id: bonbeauty",
        "    config_path: markets/bonbeauty/market.yaml",
        "  - market_id: mercur",
        "    config_path: markets/mercur/market.yaml",
        "",
      ].join("\n"),
      "utf8",
    )
    await fs.writeFile(
      path.join(instanceRoot, "markets", "bonbeauty", "market.yaml"),
      "name: Bonbeauty\nstatus: published\n",
      "utf8",
    )
    await fs.writeFile(
      path.join(instanceRoot, "markets", "mercur", "market.yaml"),
      "name: Mercur\nstatus: draft\n",
      "utf8",
    )

    const distDir = path.join(configRoot, "dist")
    const result = await materializeGpConfigSigningArtifact({
      configRoot,
      instanceId: "gp-dev",
      distDir,
      allowEphemeralKey: true,
    })

    const artifactRaw = await fs.readFile(result.artifactPath, "utf8")
    const fixtureRaw = await fs.readFile(result.fixturePath, "utf8")
    const signature = await fs.readFile(result.signaturePath)
    const publicKey = (await fs.readFile(result.publicKeyPath, "utf8")).trim()
    const artifact = JSON.parse(artifactRaw) as {
      files: Array<{ path: string }>
    }
    const fixture = JSON.parse(fixtureRaw) as {
      canonical_bytes_base64: string
      signature_base64: string
    }

    expect(result.usedEphemeralKey).toBe(true)
    expect(artifact.files.map((entry) => entry.path)).toEqual([
      "instance.yaml",
      "markets/bonbeauty/market.yaml",
      "markets/mercur/market.yaml",
    ])
    expect(Buffer.from(fixture.signature_base64, "base64")).toEqual(signature)
    expect(
      verifyEd25519Signature(
        Buffer.from(fixture.canonical_bytes_base64, "base64"),
        Buffer.from(fixture.signature_base64, "base64"),
        publicKey,
      ),
    ).toBe(true)
  })
})