import { existsSync, readFileSync } from "node:fs";

import * as yaml from "js-yaml";

import {
  CommunicationConfigNotFoundError,
  CommunicationConfigValidationError,
  UnknownFlowError,
} from "./errors";
import type { ConsentBasis } from "./types";

const CONSENT_BASIS_VALUES = new Set<ConsentBasis>([
  "transactional_critical",
  "transactional_supportive",
  "lifecycle_consented",
  "marketing",
]);

// F-04: ten sam regex co Python validator (`_grow/tools/validate_communication_flag_consistency.py`)
// — TS loader jest pierwszym gate, validator drugim. Snake_case enforced runtime.
const FLOW_ID_RE = /^[a-z][a-z0-9_]{2,63}$/;
const MARKET_ID_RE = /^[a-z][a-z0-9_-]{1,63}$/;

const SUPPORTED_SCHEMA_VERSION = 1;

export interface FlagResolverInput {
  flow_id: string;
  market_id: string;
}

export interface FlowFlagState {
  enabled: boolean;
  consent_basis: ConsentBasis;
  source: "default" | "market_override";
  flow_id: string;
  market_id: string;
}

export interface CommunicationFlowDefaults {
  enabled: boolean;
  consent_basis: ConsentBasis;
}

export interface CommunicationDefaultsConfig {
  // F-08: loose-typed number + runtime check vs literal `1` — schema bump (v2)
  // wymusza explicit migration error zamiast nieczytelnego type mismatch.
  version: number;
  flows: Record<string, CommunicationFlowDefaults>;
}

export interface MarketFlowOverride {
  enabled: boolean;
}

export interface MarketFlowsConfig {
  version: number;
  market_id: string;
  overrides: Record<string, MarketFlowOverride>;
}

export interface ICommunicationFlowFlagResolver {
  resolve(input: FlagResolverInput): FlowFlagState;
}

export class StaticCommunicationFlowFlagResolver
  implements ICommunicationFlowFlagResolver
{
  private readonly defaults: CommunicationDefaultsConfig;
  private readonly marketOverrides: Map<string, MarketFlowsConfig>;

  constructor(
    defaults: CommunicationDefaultsConfig,
    marketOverrides: Map<string, MarketFlowsConfig>,
  ) {
    // F-06: defensive deep-freeze konstruktora — caller mutujący przekazany
    // `defaults`/`marketOverrides` po construct NIE może zmienić decyzji
    // resolvera (cache-busting backdoor). Resolver jest static-only, ale gdy
    // kiedyś dojdzie hot-reload, freeze utrzyma invariant.
    this.defaults = deepFreezeDefaults(defaults);
    this.marketOverrides = new Map(
      Array.from(marketOverrides.entries(), ([marketId, cfg]) => [
        marketId,
        deepFreezeMarketFlows(cfg),
      ]),
    );
  }

  resolve(input: FlagResolverInput): FlowFlagState {
    const defaultFlow = this.defaults.flows[input.flow_id];
    if (!defaultFlow) {
      throw new UnknownFlowError(
        `Communication flow '${input.flow_id}' is not defined in defaults`,
        {
          // F-07: ujednolicony namespace `FLOW_*` (parity z `FLOW_DISABLED`
          // w gateway gated denial) — downstream analytics / runbook trzyma
          // jeden prefix dla domain flow concepts.
          error_code: "FLOW_UNKNOWN",
        },
      );
    }

    const marketConfig = this.marketOverrides.get(input.market_id);
    const marketOverride = marketConfig?.overrides[input.flow_id];
    const hasMarketOverride = marketOverride !== undefined;

    return {
      enabled: hasMarketOverride ? marketOverride.enabled : defaultFlow.enabled,
      // F-09 invariant: `consent_basis` ZAWSZE z defaults, nigdy z override
      // (governance FR-E.8) — nawet jeśli ktoś bypass-uje loader i programatycznie
      // wstrzyknie `consent_basis` w override obiekt.
      consent_basis: defaultFlow.consent_basis,
      source: hasMarketOverride ? "market_override" : "default",
      flow_id: input.flow_id,
      market_id: input.market_id,
    };
  }
}

function deepFreezeDefaults(
  cfg: CommunicationDefaultsConfig,
): CommunicationDefaultsConfig {
  for (const flow of Object.values(cfg.flows)) {
    Object.freeze(flow);
  }
  Object.freeze(cfg.flows);
  return Object.freeze(cfg);
}

function deepFreezeMarketFlows(cfg: MarketFlowsConfig): MarketFlowsConfig {
  for (const override of Object.values(cfg.overrides)) {
    Object.freeze(override);
  }
  Object.freeze(cfg.overrides);
  return Object.freeze(cfg);
}

export function loadCommunicationDefaults(
  yamlPath: string,
): CommunicationDefaultsConfig {
  if (!existsSync(yamlPath)) {
    throw new CommunicationConfigNotFoundError(
      `Communication defaults config not found: ${yamlPath}`,
      {
        error_code: "COMMUNICATION_CONFIG_NOT_FOUND",
      },
    );
  }

  const parsed = readYamlFile(yamlPath);
  return parseDefaults(parsed, yamlPath);
}

export function loadMarketFlows(
  marketId: string,
  yamlPath: string,
): MarketFlowsConfig {
  const parsed = readYamlFile(yamlPath);
  return parseMarketFlows(parsed, marketId, yamlPath);
}

function readYamlFile(yamlPath: string): unknown {
  return yaml.load(readFileSync(yamlPath, "utf8"));
}

function parseDefaults(
  value: unknown,
  yamlPath: string,
): CommunicationDefaultsConfig {
  const root = expectRecord(value, yamlPath);
  assertSchemaVersion(root.version, yamlPath);

  const flowsRoot = expectRecord(root.flows, yamlPath, "flows");
  const flows: Record<string, CommunicationFlowDefaults> = {};

  for (const [flowId, rawFlow] of Object.entries(flowsRoot)) {
    if (!FLOW_ID_RE.test(flowId)) {
      throw validationError(
        yamlPath,
        `flows.${flowId} key must match ${FLOW_ID_RE} (snake_case, 3-64 chars)`,
      );
    }
    const flow = expectRecord(rawFlow, yamlPath, `flows.${flowId}`);
    if (typeof flow.enabled !== "boolean") {
      throw validationError(yamlPath, `flows.${flowId}.enabled must be boolean`);
    }
    if (!isConsentBasis(flow.consent_basis)) {
      throw validationError(
        yamlPath,
        `flows.${flowId}.consent_basis is not a supported value`,
      );
    }
    flows[flowId] = {
      enabled: flow.enabled,
      consent_basis: flow.consent_basis,
    };
  }

  return { version: SUPPORTED_SCHEMA_VERSION, flows };
}

function parseMarketFlows(
  value: unknown,
  marketId: string,
  yamlPath: string,
): MarketFlowsConfig {
  const root = expectRecord(value, yamlPath);
  assertSchemaVersion(root.version, yamlPath);

  if (!MARKET_ID_RE.test(marketId)) {
    throw validationError(
      yamlPath,
      `market_id parameter '${marketId}' must match ${MARKET_ID_RE}`,
    );
  }

  if (root.market_id !== marketId) {
    throw validationError(
      yamlPath,
      `market_id must match requested market '${marketId}'`,
    );
  }

  const rawOverrides = root.overrides ?? {};
  const overridesRoot = expectRecord(rawOverrides, yamlPath, "overrides");
  const overrides: Record<string, MarketFlowOverride> = {};

  for (const [flowId, rawOverride] of Object.entries(overridesRoot)) {
    if (!FLOW_ID_RE.test(flowId)) {
      throw validationError(
        yamlPath,
        `overrides.${flowId} key must match ${FLOW_ID_RE}`,
      );
    }
    const override = expectRecord(rawOverride, yamlPath, `overrides.${flowId}`);
    if (typeof override.enabled !== "boolean") {
      throw validationError(
        yamlPath,
        `overrides.${flowId}.enabled must be boolean`,
      );
    }
    if ("consent_basis" in override) {
      throw validationError(
        yamlPath,
        `overrides.${flowId}.consent_basis is not allowed`,
      );
    }
    overrides[flowId] = {
      enabled: override.enabled,
    };
  }

  return { version: SUPPORTED_SCHEMA_VERSION, market_id: marketId, overrides };
}

function assertSchemaVersion(rawVersion: unknown, yamlPath: string): void {
  if (typeof rawVersion !== "number") {
    throw validationError(yamlPath, "version must be a number");
  }
  if (rawVersion !== SUPPORTED_SCHEMA_VERSION) {
    // F-08: explicit migration hint zamiast generic "version mismatch" — compiler 5.3
    // może w przyszłości wystawiać v2 schema; resolver musi failować z czytelnym
    // komunikatem zamiast nieczytelnego TS literal error.
    throw validationError(
      yamlPath,
      `expected schema version ${SUPPORTED_SCHEMA_VERSION}, got ${rawVersion}; bump @gp/messaging to read new schema`,
    );
  }
}

function expectRecord(
  value: unknown,
  yamlPath: string,
  field = "root",
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw validationError(yamlPath, `${field} must be an object`);
  }

  return value as Record<string, unknown>;
}

function validationError(
  yamlPath: string,
  message: string,
): CommunicationConfigValidationError {
  return new CommunicationConfigValidationError(
    `Invalid communication config ${yamlPath}: ${message}`,
    {
      error_code: "COMMUNICATION_CONFIG_INVALID",
    },
  );
}

function isConsentBasis(value: unknown): value is ConsentBasis {
  return typeof value === "string" && CONSENT_BASIS_VALUES.has(value as ConsentBasis);
}
