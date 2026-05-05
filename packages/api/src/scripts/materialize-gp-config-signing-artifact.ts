#!/usr/bin/env node

import * as crypto from "node:crypto"
import * as fs from "node:fs/promises"
import * as path from "node:path"

import {
  buildPublicKeyKid,
  createEd25519PrivateKey,
  exportRawEd25519PublicKey,
} from "../lib/gp-config-signing"

type MaterializeOptions = {
  configRoot?: string
  instanceId?: string
  distDir?: string
  privateKey?: string
  allowEphemeralKey?: boolean
}

type MaterializeResult = {
  artifactPath: string
  signaturePath: string
  fixturePath: string
  publicKeyPath: string
  publicKey: string
  signerKid: string
  fileCount: number
  instanceId: string
  usedEphemeralKey: boolean
}

type MaterializedFile = {
  path: string
  format: "yaml" | "text"
  data: unknown
}

const DEFAULT_CONFIG_ROOT = path.resolve(process.cwd(), "../../gp-ops/config")
const DEFAULT_DIST_DIR = path.resolve(process.cwd(), "../../gp-ops/config/dist")

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n")
}

function stableSortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stableSortValue(item))
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableSortValue(child)]),
    )
  }

  return value
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableSortValue(value), null, 2)
}

async function loadYamlModule(): Promise<{ load: (input: string) => unknown }> {
  const yamlModule = (await import("js-yaml")) as {
    load: (input: string) => unknown
  }
  return yamlModule
}

async function collectFilesRecursively(rootDir: string): Promise<string[]> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true })
  const nested = await Promise.all(
    entries
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(async (entry) => {
        const fullPath = path.join(rootDir, entry.name)
        if (entry.isDirectory()) {
          return collectFilesRecursively(fullPath)
        }

        return [fullPath]
      }),
  )

  return nested.flat().sort((left, right) => left.localeCompare(right))
}

async function buildArtifactPayload(args: {
  configRoot: string
  instanceId: string
}): Promise<{ instance_id: string; files: MaterializedFile[] }> {
  const yaml = await loadYamlModule()
  const instanceRoot = path.join(args.configRoot, args.instanceId)
  const filePaths = await collectFilesRecursively(instanceRoot)

  const files = await Promise.all(
    filePaths.map(async (filePath) => {
      const relativePath = path.relative(instanceRoot, filePath).replace(/\\/g, "/")
      const raw = normalizeText(await fs.readFile(filePath, "utf8"))
      const isYaml = /\.(yaml|yml)$/i.test(filePath)

      return {
        path: relativePath,
        format: isYaml ? "yaml" : "text",
        data: isYaml ? stableSortValue(yaml.load(raw)) : raw,
      } satisfies MaterializedFile
    }),
  )

  return {
    instance_id: args.instanceId,
    files,
  }
}

function resolveSigningKey(args: {
  privateKey: string | undefined
  allowEphemeralKey: boolean
}): {
  privateKey: crypto.KeyObject
  publicKey: crypto.KeyObject
  usedEphemeralKey: boolean
} {
  if (args.privateKey) {
    const privateKey = createEd25519PrivateKey(args.privateKey)
    return {
      privateKey,
      publicKey: crypto.createPublicKey(privateKey),
      usedEphemeralKey: false,
    }
  }

  if (!args.allowEphemeralKey) {
    throw new Error(
      "GP_CONFIG_SIGNING_PRIVKEY or GP_CONFIG_SIGNING_PRIVATE_KEY is required when ephemeral signing is disabled.",
    )
  }

  const generated = crypto.generateKeyPairSync("ed25519")
  return {
    privateKey: generated.privateKey,
    publicKey: generated.publicKey,
    usedEphemeralKey: true,
  }
}

export async function materializeGpConfigSigningArtifact(
  options: MaterializeOptions = {},
): Promise<MaterializeResult> {
  const configRoot = options.configRoot ?? process.env.GP_CONFIG_ROOT ?? DEFAULT_CONFIG_ROOT
  const instanceId = options.instanceId ?? process.env.GP_INSTANCE_ID ?? "gp-dev"
  const distDir = options.distDir ?? process.env.GP_CONFIG_DIST_DIR ?? DEFAULT_DIST_DIR
  const privateKey =
    options.privateKey ??
    process.env.GP_CONFIG_SIGNING_PRIVKEY ??
    process.env.GP_CONFIG_SIGNING_PRIVATE_KEY
  const allowEphemeralKey = options.allowEphemeralKey ?? true

  const payload = await buildArtifactPayload({ configRoot, instanceId })
  const artifactBytes = Buffer.from(
    stableStringify({
      schema_version: "gp-config-artifact.v1",
      instance_id: payload.instance_id,
      files: payload.files,
    }) + "\n",
    "utf8",
  )

  const keys = resolveSigningKey({ privateKey, allowEphemeralKey })
  const signature = crypto.sign(null, artifactBytes, keys.privateKey)
  const publicKey = exportRawEd25519PublicKey(keys.publicKey)

  await fs.mkdir(distDir, { recursive: true })

  const artifactPath = path.join(distDir, "gp-config.json")
  const signaturePath = artifactPath + ".sig"
  const fixturePath = path.join(distDir, "gp-config-signing.fixture.json")
  const publicKeyPath = path.join(distDir, "gp-config.pub")

  await fs.writeFile(artifactPath, artifactBytes)
  await fs.writeFile(signaturePath, signature)
  await fs.writeFile(
    fixturePath,
    JSON.stringify(
      {
        canonical_bytes_base64: artifactBytes.toString("base64"),
        signature_base64: signature.toString("base64"),
      },
      null,
      2,
    ) + "\n",
    "utf8",
  )
  await fs.writeFile(publicKeyPath, publicKey + "\n", "utf8")

  return {
    artifactPath,
    signaturePath,
    fixturePath,
    publicKeyPath,
    publicKey,
    signerKid: buildPublicKeyKid(publicKey),
    fileCount: payload.files.length,
    instanceId,
    usedEphemeralKey: keys.usedEphemeralKey,
  }
}

async function main(): Promise<void> {
  const result = await materializeGpConfigSigningArtifact()
  process.stdout.write(JSON.stringify(result, null, 2) + "\n")
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
