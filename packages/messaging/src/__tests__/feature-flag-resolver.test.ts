import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  CommunicationConfigNotFoundError,
  CommunicationConfigValidationError,
  StaticCommunicationFlowFlagResolver,
  UnknownFlowError,
  loadCommunicationDefaults,
  loadMarketFlows,
} from "../index";

function withTempDir<T>(callback: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "gp-messaging-flags-"));
  try {
    return callback(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeConfig(dir: string, name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content, "utf8");
  return path;
}

const defaultsYaml = `
version: 1
flows:
  voucher_delivery_recipient:
    enabled: true
    consent_basis: transactional_critical
  voucher_reminder_t7:
    enabled: false
    consent_basis: lifecycle_consented
`;

describe("StaticCommunicationFlowFlagResolver", () => {
  it("ładuje default i zwraca default source dla flow bez override", () => {
    withTempDir((dir) => {
      const defaults = loadCommunicationDefaults(
        writeConfig(dir, "defaults.yaml", defaultsYaml),
      );
      const bonbeauty = loadMarketFlows(
        "bonbeauty",
        writeConfig(
          dir,
          "bonbeauty.yaml",
          `
version: 1
market_id: bonbeauty
overrides:
  voucher_reminder_t7:
    enabled: true
`,
        ),
      );
      const resolver = new StaticCommunicationFlowFlagResolver(
        defaults,
        new Map([["bonbeauty", bonbeauty]]),
      );

      expect(
        resolver.resolve({
          flow_id: "voucher_delivery_recipient",
          market_id: "bonbeauty",
        }),
      ).toMatchObject({
        enabled: true,
        consent_basis: "transactional_critical",
        source: "default",
      });
    });
  });

  it("stosuje per-market override i zachowuje consent_basis z defaults", () => {
    withTempDir((dir) => {
      const defaults = loadCommunicationDefaults(
        writeConfig(dir, "defaults.yaml", defaultsYaml),
      );
      const bonbeauty = loadMarketFlows(
        "bonbeauty",
        writeConfig(
          dir,
          "bonbeauty.yaml",
          `
version: 1
market_id: bonbeauty
overrides:
  voucher_reminder_t7:
    enabled: true
`,
        ),
      );
      const resolver = new StaticCommunicationFlowFlagResolver(
        defaults,
        new Map([["bonbeauty", bonbeauty]]),
      );

      expect(
        resolver.resolve({
          flow_id: "voucher_reminder_t7",
          market_id: "bonbeauty",
        }),
      ).toMatchObject({
        enabled: true,
        consent_basis: "lifecycle_consented",
        source: "market_override",
      });
    });
  });

  it("dziedziczy defaults dla marketu bez override file", () => {
    withTempDir((dir) => {
      const defaults = loadCommunicationDefaults(
        writeConfig(dir, "defaults.yaml", defaultsYaml),
      );
      const resolver = new StaticCommunicationFlowFlagResolver(
        defaults,
        new Map(),
      );

      expect(
        resolver.resolve({
          flow_id: "voucher_reminder_t7",
          market_id: "unknown-market",
        }),
      ).toMatchObject({
        enabled: false,
        source: "default",
      });
    });
  });

  it("rzuca UnknownFlowError dla nieznanego flow_id", () => {
    withTempDir((dir) => {
      const defaults = loadCommunicationDefaults(
        writeConfig(dir, "defaults.yaml", defaultsYaml),
      );
      const resolver = new StaticCommunicationFlowFlagResolver(
        defaults,
        new Map(),
      );

      expect(() =>
        resolver.resolve({
          flow_id: "not_existing",
          market_id: "bonbeauty",
        }),
      ).toThrow(UnknownFlowError);
    });
  });

  it("rzuca CommunicationConfigNotFoundError dla brakującego defaults YAML", () => {
    expect(() => loadCommunicationDefaults("/tmp/gp-missing-defaults.yaml")).toThrow(
      CommunicationConfigNotFoundError,
    );
  });

  it("rzuca validation error przy market_id niezgodnym z parametrem", () => {
    withTempDir((dir) => {
      const path = writeConfig(
        dir,
        "market.yaml",
        `
version: 1
market_id: bonevent
overrides: {}
`,
      );

      expect(() => loadMarketFlows("bonbeauty", path)).toThrow(
        CommunicationConfigValidationError,
      );
    });
  });

  it("rzuca validation error gdy override próbuje zmienić consent_basis", () => {
    withTempDir((dir) => {
      const path = writeConfig(
        dir,
        "market.yaml",
        `
version: 1
market_id: bonbeauty
overrides:
  voucher_reminder_t7:
    enabled: true
    consent_basis: marketing
`,
      );

      expect(() => loadMarketFlows("bonbeauty", path)).toThrow(
        CommunicationConfigValidationError,
      );
    });
  });
});
