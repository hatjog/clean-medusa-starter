const { loadEnv } = require("@medusajs/utils");
loadEnv("test", process.cwd());

// NOTE: Some unit tests (init-market.unit.spec.ts) import from ../portal/ (sibling module in monorepo).
// These tests MUST be run from within the GP/ monorepo context (cd GP/backend && yarn test:unit).
// Running this submodule standalone (outside the monorepo) will fail with MODULE_NOT_FOUND.
// This is a known monorepo coupling — the test belongs conceptually to GP/portal but requires Jest mocking.

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
  testEnvironment: "node",
  moduleFileExtensions: ["js", "ts", "json"],
  modulePathIgnorePatterns: ["dist/", "<rootDir>/.medusa/"],
  setupFiles: ["./integration-tests/setup.js"],
};

if (process.env.TEST_TYPE === "integration:http") {
  module.exports.testMatch = ["**/integration-tests/http/*.spec.[jt]s"];
} else if (process.env.TEST_TYPE === "integration:modules") {
  module.exports.testMatch = ["**/src/modules/*/__tests__/**/*.[jt]s"];
} else if (process.env.TEST_TYPE === "unit") {
  module.exports.testMatch = ["**/src/**/__tests__/**/*.unit.spec.[jt]s"];
}
