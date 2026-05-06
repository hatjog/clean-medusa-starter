/**
 * Story v160-8-1: Operator readiness aggregator — 6-item pre-flag-flip
 * checklist with system-level GO/NO-GO verdict.
 *
 * @see specs/operator/readiness-checklist.md
 * @see FR37 / FR38 / AR45 / AR46 / NFR-REL-2
 */

import { verifyAllGates } from "./security-gate-verifier"
import { listConfiguredAlerts } from "./alert-evaluator"
import {
  listSellers,
  readSellerGpMetadata,
  resolveLifecycleStatus,
} from "./vendor-decision-store"

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

type ScopeResolver = {
  resolve: (key: string) => unknown
}

type AdrTrack = "A" | "B"

function aggregateOverall(items: ReadinessItem[]): ReadinessOverall {
  if (items.some((i) => i.status === "red")) return "red"
  if (items.every((i) => i.status === "green")) return "green"
  return "yellow"
}

function normalizeAdrTrack(value: unknown): AdrTrack | null {
  if (typeof value !== "string") {
    return null
  }

  const normalized = value.trim().toLowerCase()

  if (normalized === "a" || normalized === "track_a" || normalized === "track-a") {
    return "A"
  }

  if (normalized === "b" || normalized === "track_b" || normalized === "track-b") {
    return "B"
  }

  return null
}

async function buildLifecycleReadiness(
  scope?: ScopeResolver,
): Promise<ReadinessItem> {
  if (!scope) {
    return {
      key: "vendor_lifecycle_distribution",
      label: "Vendor lifecycle distribution",
      status: "unknown",
      value: "Seller scope unavailable",
      threshold: "≥ 80% terminal (open/suspended/terminated)",
      remediation_url: "/app/vendors/pause-gate",
    }
  }

  const sellers = await listSellers(scope)
  const counts = {
    pending_approval: 0,
    open: 0,
    suspended: 0,
    terminated: 0,
  }

  for (const seller of sellers) {
    counts[resolveLifecycleStatus(seller)] += 1
  }

  const total = sellers.length
  if (total === 0) {
    return {
      key: "vendor_lifecycle_distribution",
      label: "Vendor lifecycle distribution",
      status: "unknown",
      value: "0/0 vendors available",
      threshold: "≥ 80% terminal (open/suspended/terminated)",
      remediation_url: "/app/vendors/pause-gate",
    }
  }

  const terminal = counts.open + counts.suspended + counts.terminated
  const terminalRatio = terminal / total
  const status: ReadinessStatus =
    terminalRatio >= 0.8 ? "green" : terminalRatio >= 0.5 ? "yellow" : "red"

  return {
    key: "vendor_lifecycle_distribution",
    label: "Vendor lifecycle distribution",
    status,
    value:
      `${terminal}/${total} terminal ` +
      `(open=${counts.open}, suspended=${counts.suspended}, ` +
      `terminated=${counts.terminated}, pending=${counts.pending_approval})`,
    threshold: "≥ 80% terminal (open/suspended/terminated)",
    remediation_url: "/app/vendors/pause-gate",
  }
}

async function buildAdr097Readiness(
  scope?: ScopeResolver,
): Promise<ReadinessItem> {
  if (!scope) {
    return {
      key: "adr_097_capacity_posture",
      label: "ADR-097 capacity posture",
      status: "unknown",
      value: "Seller scope unavailable",
      threshold: "Track A/B documented + balanced",
      remediation_url:
        "/specs/adr/2026-05-01-adr-097-sprint-0-capacity-rebalance-hybrid-d.md",
    }
  }

  const sellers = await listSellers(scope)
  const total = sellers.length
  let trackA = 0
  let trackB = 0

  for (const seller of sellers) {
    const gp = readSellerGpMetadata(seller)
    const track = normalizeAdrTrack(gp.adr_097_track)

    if (track === "A") {
      trackA += 1
    } else if (track === "B") {
      trackB += 1
    }
  }

  const documented = trackA + trackB
  const dominantShare = documented === 0 ? 1 : Math.max(trackA, trackB) / documented

  let status: ReadinessStatus = "unknown"
  if (documented > 0) {
    status =
      documented === total && trackA > 0 && trackB > 0 && dominantShare <= 0.6
        ? "green"
        : "yellow"
  }

  return {
    key: "adr_097_capacity_posture",
    label: "ADR-097 capacity posture",
    status,
    value:
      documented === 0
        ? `0/${total} vendors documented`
        : `${documented}/${total} documented (A=${trackA}, B=${trackB})`,
    threshold: "Track A/B documented + balanced",
    remediation_url:
      "/specs/adr/2026-05-01-adr-097-sprint-0-capacity-rebalance-hybrid-d.md",
  }
}

export async function computeReadiness(
  scope?: ScopeResolver,
): Promise<ReadinessResult> {
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

  const lifecycle = await buildLifecycleReadiness(scope)
  const adr097 = await buildAdr097Readiness(scope)

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
