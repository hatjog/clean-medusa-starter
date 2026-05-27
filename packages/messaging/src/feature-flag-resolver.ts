import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

import {
  CommunicationConfigNotFoundError,
  CommunicationConfigValidationError,
  UnknownFlowError,
} from "./errors";
import type { ConsentBasis } from "./types";

const requireYaml = createRequire(__filename);
const yaml = requireYaml("js-yaml") as { load(source: string): unknown };

const CONSENT_BASIS_VALUES = new Set<ConsentBasis>([
  "transactional_critical",
  "transactional_supportive",
  "lifecycle_consented",
  "marketing",
]);

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
  version: 1;
  flows: Record<string, CommunicationFlowDefaults>;
}

export interface MarketFlowOverride {
  enabled: boolean;
}

export interface MarketFlowsConfig {
  version: 1;
  market_id: string;
  overrides: Record<string, MarketFlowOverride>;
}

export interface ICommunicationFlowFlagResolver {
  resolve(input: FlagResolverInput): FlowFlagState;
}

export class StaticCommunicationFlowFlagResolver
  implements ICommunicationFlowFlagResolver
{
  constructor(
    private readonly defaults: CommunicationDefaultsConfig,
    private readonly marketOverrides: Map<string, MarketFlowsConfig>,
  ) {}

  resolve(input: FlagResolverInput): FlowFlagState {
    const defaultFlow = this.defaults.flows[input.flow_id];
    if (!defaultFlow) {
      throw new UnknownFlowError(
        `Communication flow '${input.flow_id}' is not defined in defaults`,
        {
          error_code: "COMMUNICATION_FLOW_UNKNOWN",
        },
      );
    }

    const marketConfig = this.marketOverrides.get(input.market_id);
    const marketOverride = marketConfig?.overrides[input.flow_id];
    const hasMarketOverride = marketOverride !== undefined;

    return {
      enabled: hasMarketOverride ? marketOverride.enabled : defaultFlow.enabled,
      consent_basis: defaultFlow.consent_basis,
      source: hasMarketOverride ? "market_override" : "default",
      flow_id: input.flow_id,
      market_id: input.market_id,
    };
  }
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

  if (root.version !== 1) {
    throw validationError(yamlPath, "version must equal 1");
  }

  const flowsRoot = expectRecord(root.flows, yamlPath, "flows");
  const flows: Record<string, CommunicationFlowDefaults> = {};

  for (const [flowId, rawFlow] of Object.entries(flowsRoot)) {
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

  return { version: 1, flows };
}

function parseMarketFlows(
  value: unknown,
  marketId: string,
  yamlPath: string,
): MarketFlowsConfig {
  const root = expectRecord(value, yamlPath);

  if (root.version !== 1) {
    throw validationError(yamlPath, "version must equal 1");
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

  return { version: 1, market_id: marketId, overrides };
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
