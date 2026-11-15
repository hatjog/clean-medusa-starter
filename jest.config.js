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
} else if (process.env.TEST_TYPE === "owed-unit-ack-pg") {
  // v1.16.0 Story 3.1 AC3 — kontrakt „ACK vs jednostki nalezne" (AD-47) i dowod
  // luki `200 duplicate` na realnym PostgreSQL. DATABASE_URL musi wskazywac
  // IZOLOWANA DB testowa (temp tables + ROLLBACK, ale rejestr kompensacji jest
  // czytany z realnej tabeli `money_path_compensation_failure`).
  module.exports.testMatch = [
    "**/packages/api/src/__tests__/integration/stripe-payment-intent-owed-unit-ack-pg.integration.test.[jt]s",
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
} else if (process.env.TEST_TYPE === "cart-completion-psp-authority-pg") {
  // v1.16.0 Story 8.2/8.6 — autorytet PSP i blokada completion (ADR-233) na realnym
  // Postgresie (TEMP-lustra, schemat fixture puli sagi, proces potomny trzymajacy blokade).
  // Suita zaklada i kasuje dane fixture, wiec DATABASE_URL musi wskazywac IZOLOWANA DB
  // testowa (warstwa A w integration-tests/setup.js). Przeniesiona z profilu unit:
  // bramka `test-db-isolation` (DW-15-138) czerwienila ja jako suite bezprofilowa.
  module.exports.testMatch = [
    "**/packages/api/src/api/middlewares/__tests__/cart-completion-psp-authority-pg.integration.test.[jt]s",
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
} else if (process.env.TEST_TYPE === "voucher-redemption-pg") {
  // v1.15.0 Story 5.7 (FR-12a/b/c, AI-2.2) — kanoniczna `voucher_redemption`
  // OŻYWIONA, na REALNYM Postgresie: DDL wykonany z plików migracji, ruch rolą
  // BEZ superusera i BEZ własności tabeli, kontrola negatywna grantów jako
  // realna próba zapisu. Profil istnieje, bo suita, której nie odpala żaden
  // profil, jest mechanizmem martwym — dokładnie ten defekt znalazła 2.6
  // w `packages/api/src/__tests__/rls/**` (`No tests found`).
  // DATABASE_URL musi wskazywać IZOLOWANĄ DB: suita DROP-uje tabele modułu.
  module.exports.testMatch = [
    "**/packages/api/src/__tests__/rls/voucher-redemption.integration.spec.[jt]s",
  ];
} else if (process.env.TEST_TYPE === "redeem-for-seller-pg") {
  // v1.15.0 Story 5.8 (FR-10a/d/e/f, AD-17, AD-20, ADR-199) — `redeemForSeller`
  // na REALNYM Postgresie: allow-lista stanow z dowodem czerwieni wykonanym
  // w suicie, kontrola TOCTOU ROWNOLEGLA (sekwencyjna nie zlapalaby defektu),
  // idempotencja liczona wierszami kanonicznej. Suita bez profilu jest
  // mechanizmem martwym — dokladnie ten defekt znalazla 2.6.
  // DATABASE_URL musi wskazywac IZOLOWANA DB: suita DROP-uje tabele modulu.
  module.exports.testMatch = [
    "**/packages/api/src/__tests__/rls/voucher-redeem-for-seller.integration.spec.[jt]s",
  ];
} else if (process.env.TEST_TYPE === "story-4-4-deferred-trace-pg") {
  // v1.16.0 Story 4.4 (FR-12, AD-32) — trwaly rekord deferred_issuance_trace
  // na realnym Postgresie (migracja up/down, RLS market_isolation, domkniecie).
  // DATABASE_URL musi wskazywac IZOLOWANA DB testowa (*_test).
  module.exports.testMatch = [
    "**/packages/api/src/__tests__/integration/story-4-4-deferred-issuance-trace-pg.integration.test.[jt]s",
  ];
} else if (process.env.TEST_TYPE === "story-4-5-trace-age-pg") {
  // v1.16.0 Story 4.5 (FR-12, AD-32) — wiek sladu z jednej migawki bazy
  // (statement_timestamp() - psp_occurred_at) i prog z recovery-config.ts.
  // DATABASE_URL musi wskazywac IZOLOWANA DB testowa (*_test).
  module.exports.testMatch = [
    "**/packages/api/src/__tests__/integration/story-4-5-trace-age-snapshot-pg.integration.test.[jt]s",
  ];
} else if (process.env.TEST_TYPE === "story-4-3-compensation-alarm-pg") {
  // v1.16.0 Story 4.3 (FR-11, AD-32, AD-48) — runtime alarm compensation_failure po terminie
  // (deadline < statement_timestamp()), pusta populacja mierzalna, kontrola dodatnia.
  // DATABASE_URL musi wskazywac IZOLOWANA DB testowa (*_test).
  module.exports.testMatch = [
    "**/packages/api/src/__tests__/integration/story-4-3-compensation-alarm-pg.integration.test.[jt]s",
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
} else if (process.env.TEST_TYPE === "story-4-2-compensation-failure-pg") {
  // v1.16.0 Story 4.2 (FR-11, AD-32) — migracja kolumn recovery tabeli
  // money_path_compensation_failure (backfill do kwarantanny, RLS) na realnym PG.
  module.exports.testMatch = [
    "**/packages/api/src/__tests__/integration/story-4-2-compensation-failure-migration-pg.integration.test.[jt]s",
  ];
} else if (process.env.TEST_TYPE === "dispatch-barrier-pg") {
  // v1.15.0 Story 4.1 — bariera idempotencji wysylki wykonana przez sam modul
  // na realnym Postgresie (knex.raw). DATABASE_URL musi wskazywac IZOLOWANA DB
  // testowa: suita zaklada i kasuje `messaging_dispatch_barrier` oraz
  // `voucher_delivery_dispatch`.
  module.exports.testMatch = [
    "**/packages/api/src/__tests__/integration/messaging-dispatch-barrier-pg.integration.test.[jt]s",
  ];
} else if (process.env.TEST_TYPE === "delivery-state-pg") {
  // v1.15.0 Story 4.2 — Brevo webhook state transition on REAL PostgreSQL.
  // DATABASE_URL must point at an isolated database; the suite creates and
  // removes only its voucher delivery tables.
  module.exports.testMatch = [
    "**/packages/api/src/__tests__/integration/brevo-delivery-state-pg.integration.test.[jt]s",
  ];
} else if (process.env.TEST_TYPE === "dispatch-window-provider") {
  // v1.15.0 Story 4.5 (AC4) — DOWOD PO STRONIE DOSTAWCY. Wysyla REALNE maile
  // przez `BrevoHttpClient` i liczy je odczytem z konta Brevo. Bez
  // `BREVO_API_KEY` / `BREVO_LIVE_PROOF_RECIPIENT` suita jest `describe.skip` —
  // nigdy nie klamie zielenia.
  module.exports.testMatch = [
    "**/packages/api/src/__tests__/integration/dispatch-window-provider.integration.test.[jt]s",
  ];
} else if (process.env.TEST_TYPE === "addressing-axis-pg") {
  // v1.16.0 Story 6.4 (AC2) — oś (a) adresowania z kontrolą dodatnią na realnym
  // PostgreSQL (DATABASE_URL = izolowana gp_story_6_4_test; własny schemat).
  module.exports.testMatch = [
    "**/packages/api/src/__tests__/integration/addressing-axis-pg.integration.test.[jt]s",
  ];
} else if (process.env.TEST_TYPE === "story-3-6-canonical-state-pg") {
  module.exports.testMatch = [
    "**/packages/api/src/__tests__/integration/story-3-6-canonical-state-provenance-pg.integration.test.[jt]s",
  ];
} else if (process.env.TEST_TYPE === "story-3-3-shared-barrier-pg") {
  // v1.16.0 Story 3.3 (FR-9, AD-33) — wspolna bariera skutku per nalezna
  // jednostka na realnym PostgreSQL (DATABASE_URL = izolowana *_test).
  module.exports.testMatch = [
    "**/packages/api/src/__tests__/integration/story-3-3-shared-barrier-atomic-pg.integration.test.[jt]s",
  ];
} else if (process.env.TEST_TYPE === "story-3-4-transport-reservation-pg") {
  // v1.16.0 Story 3.4 (FR-10, AD-33) — rezerwacja transportu nie wyprzedza
  // konsumpcji biznesowej; obie trasy webhooka na realnym PostgreSQL (*_test).
  module.exports.testMatch = [
    "**/packages/api/src/__tests__/integration/story-3-4-transport-reservation-after-consumption-pg.integration.test.[jt]s",
  ];
} else if (process.env.TEST_TYPE === "voucher-service-redeem-pg") {
  // v1.16.0 Story 5.4 (FR-19, AD-34) — realizacja VOUCHER_SERVICE jednym aktem,
  // atomowość aktu i śladu, rozłączność gałęzi. DATABASE_URL musi wskazywać
  // IZOLOWANĄ DB `*_test`: suity DROP-ują i odtwarzają tabele modułu voucher.
  module.exports.testMatch = [
    "**/packages/api/src/__tests__/integration/voucher-service-redeem-single-act.integration.spec.[jt]s",
    "**/packages/api/src/__tests__/integration/voucher-service-redeem-atomicity.integration.spec.[jt]s",
    "**/packages/api/src/__tests__/integration/voucher-redeem-branch-disjointness.integration.spec.[jt]s",
  ];
} else if (process.env.TEST_TYPE === "story-4-7-recovery-read-pg") {
  // v1.16.0 Story 4.7 — jedno wejście odczytu trzech populacji pod RLS (DB *_test).
  module.exports.testMatch = [
    "**/packages/api/src/__tests__/integration/story-4-7-recovery-read-pg.integration.test.[jt]s",
  ];
} else if (process.env.TEST_TYPE === "story-4-6-dlq-pg") {
  // v1.16.0 Story 4.6 — nośnik DLQ (mor_policy_dlq_entry) pod RLS na realnym
  // PostgreSQL; wyłącznie własna suita (DATABASE_URL = izolowana DB *_test).
  module.exports.testMatch = [
    "**/packages/api/src/__tests__/integration/story-4-6-dlq-pg.integration.test.[jt]s",
  ];
} else if (process.env.TEST_TYPE === "story-11-1-runtime-recovery-pg") {
  // Story 11.1 — profil musi wskazywać wyłącznie własne suity. Bez tego
  // nieznany TEST_TYPE pozostawia domyślny discovery Jesta i miesza dowód
  // RLS/NOT_RUN z niepowiązanymi testami jednostkowymi.
  module.exports.testMatch = [
    "**/packages/api/src/__tests__/integration/story-11-1-runtime-recovery-migration-pg.integration.test.[jt]s",
    "**/packages/api/src/__tests__/integration/story-11-1-runtime-scope-pg.integration.test.[jt]s",
    "**/packages/api/src/__tests__/integration/story-11-1-provisioning-roles-pg.integration.test.[jt]s",
    "**/packages/api/src/__tests__/integration/story-11-1-runtime-recovery-boundary-pg.integration.test.[jt]s",
    "**/packages/api/src/__tests__/integration/story-11-1-provenance-inventory-pg.integration.test.[jt]s",
    "**/packages/api/src/__tests__/integration/story-11-1-retention-inventory-pg.integration.test.[jt]s",
    "**/packages/api/src/__tests__/integration/story-11-1-runtime-writers-pg.integration.test.[jt]s",
  ];
} else if (process.env.TEST_TYPE === "story-8-4-partial-line-failure-pg") {
  // v1.16.0 Story 8.4 — częściowa porażka pozycji prezentowych (SAVEPOINT per
  // linia) na realnym PG; DATABASE_URL musi wskazywać bazę `*_test`.
  module.exports.testMatch = [
    "**/packages/api/src/__tests__/integration/story-8-4-partial-line-failure-pg.integration.test.[jt]s",
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
