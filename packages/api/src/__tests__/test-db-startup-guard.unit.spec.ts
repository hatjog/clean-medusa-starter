import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const BACKEND_ROOT = resolve(__dirname, "../../../..");
const JEST_CONFIG_PATH = join(BACKEND_ROOT, "jest.config.js");
const JEST_BINARY_PATH = require.resolve("jest/bin/jest", {
  paths: [BACKEND_ROOT],
});
const FIXTURE_EXECUTED = "TEST_DB_JEST_FIXTURE_EXECUTED";
const DIRECT_CONNECTION_BLOCKED = "TEST_DB_DIRECT_CONNECTION_BLOCKED";
const ORIGINAL_CONNECT_REACHED = "TEST_DB_ORIGINAL_CONNECT_REACHED";

type BootstrapResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  output: string;
};

function runBootstrap(options: {
  databaseUrl?: string;
  envFileDatabaseUrl?: string;
  allowedDatabaseNames?: string;
  directConnectionUrl?: string;
  testType?: string;
}): BootstrapResult {
  const cwd = mkdtempSync(join(tmpdir(), "gp-test-db-startup-guard-"));
  const fixtureLocation =
    options.testType === "unit"
      ? {
          directory: join(BACKEND_ROOT, "packages/api/src/__tests__"),
          filename: "startup-guard.fixture.unit.spec.js",
        }
      : options.testType === "patches"
        ? {
            directory: join(BACKEND_ROOT, "__tests__/patches"),
            filename: "startup-guard.fixture.spec.js",
          }
        : {
            directory: BACKEND_ROOT,
            filename: "startup-guard.fixture.test.js",
          };
  const fixtureDirectory = mkdtempSync(
    join(fixtureLocation.directory, ".test-db-startup-guard-"),
  );
  const fixturePath = join(fixtureDirectory, fixtureLocation.filename);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TEST_TYPE: options.testType ?? "profile-name-cannot-authorize-database",
  };

  delete env.DATABASE_URL;
  delete env.DB_HOST;
  delete env.DB_PORT;
  delete env.DB_USERNAME;
  delete env.DB_PASSWORD;
  delete env.GP_TEST_DATABASE_NAMES;
  delete env.GP_TEST_CONNECTION_TARGET_URL;

  if (options.databaseUrl !== undefined) {
    env.DATABASE_URL = options.databaseUrl;
  }

  if (options.allowedDatabaseNames !== undefined) {
    env.GP_TEST_DATABASE_NAMES = options.allowedDatabaseNames;
  }

  if (options.directConnectionUrl !== undefined) {
    env.GP_TEST_CONNECTION_TARGET_URL = options.directConnectionUrl;
  }

  if (options.envFileDatabaseUrl !== undefined) {
    writeFileSync(
      cwd + "/.env.test",
      `DATABASE_URL=${options.envFileDatabaseUrl}\n`,
    );
  } else {
    writeFileSync(cwd + "/.env.test", "");
  }

  writeFileSync(
    fixturePath,
    [
      "const pg = require('pg')",
      "",
      "test('jest executes this fixture only after setupFiles', async () => {",
      `  console.log(${JSON.stringify(FIXTURE_EXECUTED)})`,
      "  const directConnectionUrl = process.env.GP_TEST_CONNECTION_TARGET_URL",
      "  if (!directConnectionUrl) return",
      "",
      "  const client = new pg.Client({ connectionString: directConnectionUrl, connectionTimeoutMillis: 250 })",
      "  try {",
      "    await client.connect()",
      `    console.log(${JSON.stringify(ORIGINAL_CONNECT_REACHED)})`,
      "    throw new Error('Polaczenie do celu testowego nie zostalo zatrzymane przez bramke.')",
      "  } catch (error) {",
      "    if (!String(error?.message).includes('[test-db-guard]')) {",
      `      console.log(${JSON.stringify(ORIGINAL_CONNECT_REACHED)})`,
      "      throw error",
      "    }",
      `    console.log(${JSON.stringify(DIRECT_CONNECTION_BLOCKED)})`,
      "  } finally {",
      "    await client.end().catch(() => undefined)",
      "  }",
      "})",
      "",
    ].join("\n"),
  );

  try {
    const result = spawnSync(
      process.execPath,
      [
        JEST_BINARY_PATH,
        "--config",
        JEST_CONFIG_PATH,
        "--runTestsByPath",
        fixturePath,
        "--runInBand",
      ],
      {
        cwd,
        env,
        encoding: "utf8",
        timeout: 15_000,
      },
    );

    return {
      status: result.status,
      signal: result.signal,
      output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
}

function expectBootstrapRefusal(result: BootstrapResult) {
  expect(result.status).not.toBe(0);
  expect(result.status).toBe(1);
  expect(result.signal).toBeNull();
  expect(result.output).toContain("[test-db-guard]");
  expect(result.output).not.toContain(FIXTURE_EXECUTED);
}

describe("test database startup guard", () => {
  it("refuses an explicit development URL before Jest executes a fixture despite .env.test", () => {
    const syntheticPassword = Buffer.from("c2VrcmV0", "base64").toString(
      "utf8",
    );
    const developmentUrl = `postgres://test-user:${syntheticPassword}@127.0.0.1:5432/gp_mercur`;
    const result = runBootstrap({
      databaseUrl: developmentUrl,
      envFileDatabaseUrl: "postgres://127.0.0.1:55432/gp_mercur_test",
    });

    expectBootstrapRefusal(result);
    expect(result.output).toContain("gp_mercur");
    expect(result.output).not.toContain(syntheticPassword);
    expect(result.output).not.toContain(developmentUrl);
  });

  it("loads an isolated URL from .env.test when no explicit runtime value exists", () => {
    const result = runBootstrap({
      envFileDatabaseUrl: "postgres://127.0.0.1:55432/gp_mercur_test",
    });

    expect(result.status).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.output).toContain(FIXTURE_EXECUTED);
  });

  it.each(["unit", "patches"])(
    "refuses a missing URL for the %s profile before the Jest fixture runs",
    (testType) => {
      const result = runBootstrap({ testType });

      expectBootstrapRefusal(result);
      expect(result.output).toContain("DATABASE_URL");
    },
  );

  it("prefers an explicit isolated test database over a misleading .env.test value", () => {
    const result = runBootstrap({
      databaseUrl: "postgres://127.0.0.1:55432/gp_mercur_test",
      envFileDatabaseUrl: "postgres://127.0.0.1:5432/gp_mercur",
    });

    expect(result.status).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.output).toContain(FIXTURE_EXECUTED);
  });

  it("permits an explicitly named test database for a destructive profile", () => {
    const result = runBootstrap({
      databaseUrl: "postgres://127.0.0.1:55432/gp_mercur-smoke-test",
      allowedDatabaseNames: "gp_mercur-smoke-test",
      testType: "destructive-pg",
    });

    expect(result.status).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.output).toContain(FIXTURE_EXECUTED);
  });

  it("refuses a non-suffix test database for a destructive profile without the explicit safe allowlist", () => {
    const result = runBootstrap({
      databaseUrl: "postgres://127.0.0.1:55432/gp_mercur-smoke-test",
      testType: "destructive-pg",
    });

    expectBootstrapRefusal(result);
    expect(result.output).toContain("gp_mercur-smoke-test");
  });

  it("rejects a developer target requested after startup even when the allowlist names it", () => {
    const syntheticPassword = Buffer.from("c2VrcmV0", "base64").toString(
      "utf8",
    );
    const directConnectionUrl = `postgres://test-user:${syntheticPassword}@127.0.0.1:1/gp_mercur`;
    const result = runBootstrap({
      databaseUrl: "postgres://127.0.0.1:55432/gp_mercur_test",
      allowedDatabaseNames: "gp_mercur",
      directConnectionUrl,
    });

    expect(result.status).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.output).toContain(FIXTURE_EXECUTED);
    expect(result.output).toContain(DIRECT_CONNECTION_BLOCKED);
    expect(result.output).not.toContain(ORIGINAL_CONNECT_REACHED);
    expect(result.output).not.toContain(syntheticPassword);
    expect(result.output).not.toContain(directConnectionUrl);
  });

  it("rejects a non-test target requested after startup even when an environment allowlist names it", () => {
    const syntheticPassword = Buffer.from("c2VrcmV0", "base64").toString(
      "utf8",
    );
    const directConnectionUrl = `postgres://test-user:${syntheticPassword}@127.0.0.1:1/gp_mercur_prod`;
    const result = runBootstrap({
      databaseUrl: "postgres://127.0.0.1:55432/gp_mercur_test",
      allowedDatabaseNames: "gp_mercur_prod",
      directConnectionUrl,
    });

    expect(result.status).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.output).toContain(FIXTURE_EXECUTED);
    expect(result.output).toContain(DIRECT_CONNECTION_BLOCKED);
    expect(result.output).not.toContain(ORIGINAL_CONNECT_REACHED);
    expect(result.output).not.toContain(syntheticPassword);
    expect(result.output).not.toContain(directConnectionUrl);
  });

  it.each([
    ["an unresolved URL", undefined, "DATABASE_URL"],
    ["an empty URL", "", "DATABASE_URL"],
    ["a whitespace-only URL", " \t ", "DATABASE_URL"],
    ["a malformed URL", "postgres://%invalid/gp_mercur", "DATABASE_URL"],
    [
      "a URL without a database name",
      "postgres://127.0.0.1:5432",
      "nazwe bazy",
    ],
    [
      "an unsupported URL scheme",
      "http://127.0.0.1:5432/gp_mercur_test",
      "schematu",
    ],
    [
      "the gp_mercur development database",
      "postgres://127.0.0.1:5432/gp_mercur",
      "gp_mercur",
    ],
    [
      "the gp_core development database",
      "postgres://127.0.0.1:5432/gp_core",
      "gp_core",
    ],
    [
      "the gp_portal development database",
      "postgres://127.0.0.1:5432/gp_portal",
      "gp_portal",
    ],
  ])(
    "refuses %s before the Jest fixture runs",
    (_caseName, databaseUrl, expectedMessage) => {
      const result = runBootstrap({ databaseUrl });

      expectBootstrapRefusal(result);
      expect(result.output).toContain(expectedMessage);
      if (databaseUrl?.trim()) {
        expect(result.output).not.toContain(databaseUrl);
      }
    },
  );
});
