module.exports = {
  rootDir: ".",
  transform: {
    "^.+\\.[jt]s$": [
      "@swc/jest",
      {
        jsc: {
          parser: { syntax: "typescript" },
          target: "es2022",
        },
      },
    ],
  },
  testEnvironment: "node",
  testMatch: ["<rootDir>/src/__tests__/**/*.test.ts"],
  moduleFileExtensions: ["ts", "js", "json"],
  collectCoverageFrom: ["src/facade.ts", "src/payload-builder.ts", "src/policy.ts"],
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80,
    },
  },
}
