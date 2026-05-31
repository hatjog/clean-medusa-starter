const { loadEnv } = require("@medusajs/utils");
loadEnv("test", process.cwd());

// UWAGA: czesc testow unit (init-market.unit.spec.ts) importuje z ../portal/.
// Te testy musza isc z kontekstu monorepo GP (`GP/backend && yarn test:unit`).
// Samodzielny checkout submodulu poza monorepo zakonczy sie MODULE_NOT_FOUND.
// To znane sprzezenie monorepo: test konceptualnie nalezy do GP/portal, ale wymaga mockow Jest.

module.exports = {
  transform: {
    "^.+\\.[jt]s$": [
      "@swc/jest",
      {
        jsc: {
          parser: { syntax: "typescript", decorators: true },
          target: "es2022",
        },
      },
    ],
  },
  // @noble/ed25519 v2 jest ESM-only i nie przechodzi przez require() w Jest CJS.
  // Mapujemy go na reczny mock CJS oparty o Node crypto tylko w test env.
  moduleNameMapper: {
    "^@noble/ed25519$": "<rootDir>/__mocks__/@noble/ed25519.js",
    // Node16/NodeNext ESM source uses explicit `.js` extensions on relative imports
    // (e.g. `import x from "../foo.js"`), but the files are authored as `.ts` and Just
    // (@swc/jest, CJS) resolves bare specifiers via `moduleFileExtensions`. Strip the
    // `.js` so `../foo.js` → `../foo` → resolved to the real `.ts`. Without this, the
    // unit suites using ESM-style imports fail with MODULE_NOT_FOUND.
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  testEnvironment: "node",
  // Preferuj zrodla TS zamiast wygenerowanych JS przy testach sibling packages.
  moduleFileExtensions: ["ts", "js", "json"],
  modulePathIgnorePatterns: ["dist/", "<rootDir>/.medusa/"],
  setupFiles: ["./integration-tests/setup.js"],
};

if (process.env.TEST_TYPE === "integration:http") {
  module.exports.testMatch = ["**/integration-tests/http/*.spec.[jt]s"];
} else if (process.env.TEST_TYPE === "integration:modules") {
  module.exports.testMatch = ["**/packages/api/src/modules/*/__tests__/**/*.[jt]s"];
} else if (process.env.TEST_TYPE === "unit") {
  module.exports.testMatch = [
    "**/packages/api/src/**/__tests__/**/*.unit.spec.[jt]s",
    "**/packages/api/src/**/__tests__/**/*.idempotency.spec.[jt]s",
    "**/packages/api/src/**/__tests__/**/*.test.[jt]s",
    "**/packages/wallet/src/**/__tests__/**/*.test.[jt]s",
  ];
  // `*.integration.test.ts` need a live PG_CONNECTION + seeded capability grants
  // (e.g. sellers/[id]/pause), so they must NOT run in the DB-less unit suite where
  // they fail-closed. They belong to an integration invocation, not `test:unit`.
  module.exports.testPathIgnorePatterns = [
    "/node_modules/",
    "\\.integration\\.test\\.[jt]s$",
  ];
} else if (process.env.TEST_TYPE === "patches") {
  // Patch regression tests: bez live DB, oparte o mocki, szybkie.
  // Uruchomienie: pnpm test:patches
  module.exports.testMatch = ["**/__tests__/patches/**/*.spec.[jt]s"];
}
