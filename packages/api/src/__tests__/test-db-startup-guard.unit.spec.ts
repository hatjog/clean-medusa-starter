import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"

const BACKEND_ROOT = resolve(__dirname, "../../../..")
const JEST_CONFIG_PATH = join(BACKEND_ROOT, "jest.config.js")
const SETUP_PATH = join(BACKEND_ROOT, "integration-tests/setup.js")
const BOOTSTRAP_CONTINUED = "TEST_DB_BOOTSTRAP_CONTINUED"

type BootstrapResult = {
  status: number | null
  signal: NodeJS.Signals | null
  output: string
}

function runBootstrap(options: {
  databaseUrl?: string
  envFileDatabaseUrl?: string
  allowNonTestDatabase?: boolean
}): BootstrapResult {
  const cwd = mkdtempSync(join(tmpdir(), "gp-test-db-startup-guard-"))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TEST_TYPE: "profile-name-cannot-authorize-database",
  }

  delete env.DATABASE_URL
  delete env.DB_HOST
  delete env.DB_PORT
  delete env.DB_USERNAME
  delete env.DB_PASSWORD
  delete env.GP_ALLOW_NON_TEST_DB

  if (options.databaseUrl !== undefined) {
    env.DATABASE_URL = options.databaseUrl
  }

  if (options.allowNonTestDatabase) {
    env.GP_ALLOW_NON_TEST_DB = "1"
  }

  if (options.envFileDatabaseUrl !== undefined) {
    writeFileSync(cwd + "/.env.test", `DATABASE_URL=${options.envFileDatabaseUrl}\n`)
  } else {
    writeFileSync(cwd + "/.env.test", "")
  }

  const script = [
    `const jestConfig = require(${JSON.stringify(JEST_CONFIG_PATH)})`,
    "if (!Array.isArray(jestConfig.setupFiles) || !jestConfig.setupFiles.includes('./integration-tests/setup.js')) {",
    "  process.stderr.write('SETUP_FILE_NOT_CONFIGURED')",
    "  process.exit(91)",
    "}",
    `require(${JSON.stringify(SETUP_PATH)})`,
    `process.stdout.write(${JSON.stringify(BOOTSTRAP_CONTINUED)})`,
  ].join("\n")

  try {
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd,
      env,
      encoding: "utf8",
      timeout: 10_000,
    })

    return {
      status: result.status,
      signal: result.signal,
      output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

function expectBootstrapRefusal(result: BootstrapResult) {
  expect(result.status).not.toBe(0)
  expect(result.status).toBe(1)
  expect(result.signal).toBeNull()
  expect(result.output).toContain("[test-db-guard]")
  expect(result.output).not.toContain(BOOTSTRAP_CONTINUED)
}

describe("test database startup guard", () => {
  it("refuses an explicit development URL despite .env.test and the obsolete opt-out", () => {
    const syntheticPassword = Buffer.from("c2VrcmV0", "base64").toString("utf8")
    const developmentUrl = `postgres://test-user:${syntheticPassword}@127.0.0.1:5432/gp_mercur`
    const result = runBootstrap({
      databaseUrl: developmentUrl,
      envFileDatabaseUrl: "postgres://127.0.0.1:55432/gp_mercur_test",
      allowNonTestDatabase: true,
    })

    expectBootstrapRefusal(result)
    expect(result.output).toContain("gp_mercur")
    expect(result.output).not.toContain(syntheticPassword)
    expect(result.output).not.toContain(developmentUrl)
  })

  it("refuses startup when DATABASE_URL remains unresolved", () => {
    const result = runBootstrap({})

    expectBootstrapRefusal(result)
    expect(result.output).toContain("DATABASE_URL")
  })

  it("refuses a malformed resolved DATABASE_URL without echoing it", () => {
    const malformedUrl = "postgres://%invalid/gp_mercur"
    const result = runBootstrap({ databaseUrl: malformedUrl })

    expectBootstrapRefusal(result)
    expect(result.output).toContain("DATABASE_URL")
    expect(result.output).not.toContain(malformedUrl)
  })

  it("allows an explicit isolated test database despite a misleading .env.test value", () => {
    const result = runBootstrap({
      databaseUrl: "postgres://127.0.0.1:55432/gp_mercur_test",
      envFileDatabaseUrl: "postgres://127.0.0.1:5432/gp_mercur",
    })

    expect(result.status).toBe(0)
    expect(result.signal).toBeNull()
    expect(result.output).toContain(BOOTSTRAP_CONTINUED)
  })
})
