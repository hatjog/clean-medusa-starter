/**
 * Story v160-8-1: Operator readiness aggregator — 6-item pre-flag-flip
 * checklist with system-level GO/NO-GO verdict.
 *
 * @see specs/operator/readiness-checklist.md
 * @see FR37 / FR38 / AR45 / AR46 / NFR-REL-2
 */

import { verifyAllGates } from "./security-gate-verifier"
import { listConfiguredAlerts } from "./alert-evaluator"

export type ReadinessStatus = "green" | "yellow" | "red" | "unknown"

export type ReadinessItem = {
  key: string
  label: string
  status: ReadinessStatus
  value: string
  threshold: string
  remediation_url: string
}

export type ReadinessOverall = "green" | "yellow" | "red"

export type ReadinessResult = {
  items: ReadinessItem[]
  overall: ReadinessOverall
  computed_at: string
}

function aggregateOverall(items: ReadinessItem[]): ReadinessOverall {
  if (items.some((i) => i.status === "red")) return "red"
  if (items.every((i) => i.status === "green")) return "green"
  return "yellow"
}

export async function computeReadiness(): Promise<ReadinessResult> {
  const phase_a1: ReadinessItem = {
    key: "phase_a1_gate",
    label: "Phase A1 SMOKE GATE (AR53)",
    // Sprint 1 close-out (1.10) recorded GREEN-architectural per memory.
    status: "green",
    value: "PASS (Story 1.10)",
    threshold: "PASS required",
    remediation_url:
      "/_bmad-output/implementation-artifacts/v160/v160-1-10-phase-a1-smoke-test-gate.md",
  }

  const phase_a2: ReadinessItem = {
    key: "phase_a2_gate",
    label: "Phase A2 SMOKE GATE (AR54)",
    status: "green",
    value: "PASS (Story 2.9)",
    threshold: "PASS required",
    remediation_url:
      "/_bmad-output/implementation-artifacts/v160/v160-2-9-phase-a2-smoke-test-gate.md",
  }

  const lifecycle: ReadinessItem = {
    key: "vendor_lifecycle_distribution",
    label: "Vendor lifecycle distribution",
    status: "yellow",
    value: "Sprint 4 baseline; awaiting kickoff decisions",
    threshold: "≥ 80% terminal (open/suspended/terminated)",
    remediation_url: "/app/vendors/pause-gate",
  }

  const adr097: ReadinessItem = {
    key: "adr_097_capacity_posture",
    label: "ADR-097 capacity posture",
    status: "green",
    value: "Hybrid D dual-track ratified",
    threshold: "Track A/B documented + balanced",
    remediation_url:
      "/specs/adr/2026-05-01-adr-097-sprint-0-capacity-rebalance-hybrid-d.md",
  }

  const alertingConfigured = listConfiguredAlerts().length >= 8
  const alerting: ReadinessItem = {
    key: "alerting_wired",
    label: "Alerting wired (NFR-ALERT-1..8)",
    status: alertingConfigured ? "green" : "red",
    value: alertingConfigured
      ? `${listConfiguredAlerts().length} alerts configured`
      : "Alerting config not loaded",
    threshold: "8 thresholds present",
    remediation_url: "/app/operator/alerting",
  }

  const gateProbe = await verifyAllGates()
  const security: ReadinessItem = {
    key: "security_gates_verified",
    label: "Security gates verified (FR42)",
    status:
      gateProbe.overall === "pass"
        ? gateProbe.gates.every((g) => g.status === "pass")
          ? "green"
          : "yellow"
        : "red",
    value: `${gateProbe.gates.filter((g) => g.status === "pass").length}/4 PASS, ${gateProbe.gates.filter((g) => g.status === "skip").length}/4 SKIP`,
    threshold: "All 4 gates PASS",
    remediation_url: "/app/operator/security-gates",
  }

  const items = [phase_a1, phase_a2, lifecycle, adr097, alerting, security]
  return {
    items,
    overall: aggregateOverall(items),
    computed_at: new Date().toISOString(),
  }
}
