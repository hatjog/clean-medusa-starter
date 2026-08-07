const { loadEnv } = require("@medusajs/utils");
loadEnv("test", process.cwd());

// UWAGA: czesc testow unit (init-market.unit.spec.ts) importuje z ../portal/.
// Te testy musza isc z kontekstu monorepo GP (`GP/backend && yarn test:unit`).
// Samodzielny checkout submodulu poza monorepo zakonczy sie MODULE_NOT_FOUND.
// To znane sprzezenie monorepo: test konceptualnie nalezy do GP/portal, ale wymaga mockow Jest.
//
// DRUGI PRZYPADEK (v1.14.0 Story 2.2, R-2.2-I3): testy pakietu @gp/messaging
// (`packages/messaging/src/__tests__/notification-template-registry.test.ts`)
// czytaja rejestr `specs/contracts/notifications/templates.yaml` z SUPER-REPO
// (REPO_ROOT = piec poziomow w gore) — to swiadoma cena za drift-test
// bajt-w-bajt projekcji YAML->TS (tak samo robi codegen). Samodzielny checkout
// submodulu GP/backend poza monorepo nie przejdzie tych testow.

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
} else if (process.env.TEST_TYPE === "stripe-multi-order") {
  // Obowiązkowy, izolowany PG gate ADR-166; DATABASE_URL musi wskazywać DB testową.
  module.exports.testMatch = [
    "**/packages/api/src/__tests__/integration/stripe-payment-intent-multi-order-pg.integration.test.[jt]s",
  ];
} else if (process.env.TEST_TYPE === "replay-guard-pg") {
  // v1.15.0 Story 5.3 — bariera anty-replay wykonana przez sam modul na realnym
  // Postgresie (knex.raw). DATABASE_URL musi wskazywac IZOLOWANA DB testowa:
  // suita zaklada i kasuje `vendor_replay_guard`.
  module.exports.testMatch = [
    "**/packages/api/src/__tests__/integration/vendor-replay-guard-pg.integration.test.[jt]s",
  ];
} else if (process.env.TEST_TYPE === "completed-order-pg") {
  // v1.15.0 Story 3.6 — ogniwo 2 kontraktu powrotu 3DS (kardynalnosc N zamowien)
  // wykonane na realnym Postgresie przez realny handler trasy. DATABASE_URL musi
  // wskazywac IZOLOWANA DB testowa: suita zaklada i kasuje tabele fixture.
  module.exports.testMatch = [
    "**/packages/api/src/__tests__/integration/completed-order-cardinality-pg.integration.test.[jt]s",
  ];
} else if (process.env.TEST_TYPE === "voucher-rls-pg") {
  // v1.15.0 Story 2.6 (FR-14e) — moduł voucher pod RLS na REALNYM Postgresie.
  // Profil istnieje, bo `packages/api/src/__tests__/rls/**` NIE JEST objęte
  // żadnym z pozostałych `testMatch` — suity RLS leżały tam jako mechanizm,
  // którego nie odpalał żaden profil. DATABASE_URL musi wskazywać IZOLOWANĄ DB:
  // suita DROP-uje i odtwarza tabele modułu voucher.
  module.exports.testMatch = [
    "**/packages/api/src/__tests__/rls/voucher-module-rls.integration.spec.[jt]s",
  ];
} else if (process.env.TEST_TYPE === "compensation-failure-pg") {
  // v1.15.0 Story 3.5 (FR-6c, NFR-3, AD-22) — rejestr nieudanych kompensacji
  // sciezki pieniadza wykonany przez sam modul na realnym Postgresie
  // (`up`/`down` migracji + CHECK-i + ON CONFLICT). DATABASE_URL musi wskazywac
  // IZOLOWANA DB testowa: suita zaklada i kasuje
  // `money_path_compensation_failure`.
  module.exports.testMatch = [
    "**/packages/api/src/__tests__/integration/money-path-compensation-failure-pg.integration.test.[jt]s",
  ];
} else if (process.env.TEST_TYPE === "dispatch-barrier-pg") {
  // v1.15.0 Story 4.1 — bariera idempotencji wysylki wykonana przez sam modul
  // na realnym Postgresie (knex.raw). DATABASE_URL musi wskazywac IZOLOWANA DB
  // testowa: suita zaklada i kasuje `messaging_dispatch_barrier` oraz
  // `voucher_delivery_dispatch`.
  module.exports.testMatch = [
    "**/packages/api/src/__tests__/integration/messaging-dispatch-barrier-pg.integration.test.[jt]s",
  ];
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
