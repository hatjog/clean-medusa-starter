import * as yaml from "js-yaml"

const POPULATIONS = [
  "compensation_failure",
  "deferred_issuance_trace",
  "dlq_entry",
] as const

const PARTIAL_EFFECT_SUCCESSORS: Record<(typeof POPULATIONS)[number], string> = {
  compensation_failure: "recovery_in_progress",
  deferred_issuance_trace: "escalated",
  dlq_entry: "dlq_pending_ops_review",
}

type Capability = {
  retry: unknown
  resolve: unknown
  approval_required: unknown
  allowed_transitions: unknown
  terminal_states: unknown
  outcome: unknown
}

function invalid(reason: string): never {
  throw new Error(`Invalid runtime recovery capabilities contract: ${reason}`)
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    invalid(`${label} must be a non-empty string`)
  }
  return value
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string" || entry === "")) {
    invalid(`${label} must be a non-empty string array`)
  }
  return value as string[]
}

/**
 * Parses the versioned catalog consumed by recovery adapters.  The checks are
 * intentionally semantic: a syntactically valid YAML file cannot silently add
 * a terminal transition after a partial effect or merge population capabilities.
 */
export function parseRuntimeRecoveryCapabilities(source: string): void {
  const document = record(yaml.load(source), "document")
  if (document.version !== "1.0.0") invalid("version must be 1.0.0")
  if (document.contract !== "runtime-recovery-capabilities") invalid("contract name is invalid")
  if (document.semver !== "minor") invalid("semver must be minor")

  const rules = record(document.rules, "rules")
  if (rules.generic_retry_dlq !== "forbidden") invalid("generic_retry_dlq must be forbidden")
  if (rules.actor_source !== "server_verified_capability") invalid("actor_source is invalid")
  if (rules.business_unit_idempotency_key !== "required") invalid("business-unit idempotency key must be required")
  if (rules.partial_effect !== "explicit_nonterminal_state") invalid("partial effect must be explicit and nonterminal")

  const populations = record(document.populations, "populations")
  if (Object.keys(populations).length !== POPULATIONS.length || POPULATIONS.some((name) => !(name in populations))) {
    invalid("must contain exactly the three defined populations")
  }

  const retries = new Set<string>()
  const resolves = new Set<string>()
  for (const population of POPULATIONS) {
    const capability = record(populations[population], `${population} capability`) as Capability
    const retry = nonEmptyString(capability.retry, `${population}.retry`)
    const resolve = nonEmptyString(capability.resolve, `${population}.resolve`)
    if (retry === "generic_retry_dlq" || resolve === "generic_retry_dlq") invalid(`${population} uses forbidden generic retry`)
    if (retries.has(retry) || resolves.has(resolve)) invalid(`${population} does not have a distinct capability pair`)
    retries.add(retry)
    resolves.add(resolve)
    if (capability.approval_required !== true) invalid(`${population} must require approval`)
    nonEmptyString(capability.outcome, `${population}.outcome`)

    const transitions = record(capability.allowed_transitions, `${population}.allowed_transitions`)
    const terminalStates = new Set(stringArray(capability.terminal_states, `${population}.terminal_states`))
    if (terminalStates.has("partial_effect")) invalid(`${population} treats partial_effect as terminal`)
    const partialTransitions = stringArray(transitions.partial_effect, `${population}.partial_effect transitions`)
    const requiredSuccessor = PARTIAL_EFFECT_SUCCESSORS[population]
    if (partialTransitions.length !== 1 || partialTransitions[0] !== requiredSuccessor) {
      invalid(`${population} may only return partial_effect to ${requiredSuccessor}`)
    }

    const knownStates = new Set([...Object.keys(transitions), ...terminalStates])
    for (const [from, destinations] of Object.entries(transitions)) {
      for (const destination of stringArray(destinations, `${population}.${from} transitions`)) {
        if (!knownStates.has(destination)) invalid(`${population}.${from} targets unknown state ${destination}`)
      }
    }
  }
}
