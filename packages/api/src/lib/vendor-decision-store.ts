import type {
  DecisionConfirmationLocale,
  DecisionType,
} from "../modules/vendor-notifications/email-templates/decision-confirmation/i18n"
import type { LifecycleStatus } from "./vendor-lifecycle-state-machine"

export type DecisionStatus = "pending" | "opted_in" | "opted_out" | "forced"

export type SellerRecord = {
  id: string
  handle?: string | null
  email?: string | null
  name?: string | null
  status?: string | null
  store_status?: string | null
  preferred_locale?: string | null
  metadata?: unknown
}

type ScopeResolver = {
  resolve: (key: string) => unknown
}

type SellerModuleService = {
  list?: (filters: Record<string, unknown>) => Promise<unknown>
  listSellers?: (filters: Record<string, unknown>) => Promise<unknown>
  update?: (id: string, payload: Record<string, unknown>) => Promise<unknown>
  updateSeller?: (id: string, payload: Record<string, unknown>) => Promise<unknown>
  updateSellers?: (payloads: Array<Record<string, unknown>>) => Promise<unknown>
}

type LifecycleDecisionRecord = {
  decision: DecisionType
  reason?: string
  admin_note?: string | null
  captured_at?: string | null
  captured_by?: string | null
} | null

const SELLER_SERVICE_KEYS = [
  "sellerModuleService",
  "sellerService",
  "ISellerModuleService",
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function extractSellerRecords(value: unknown): SellerRecord[] {
  if (Array.isArray(value)) {
    return value.filter(isRecord) as SellerRecord[]
  }

  if (!isRecord(value)) {
    return []
  }

  for (const key of ["data", "rows", "results", "sellers"] as const) {
    const nested = value[key]
    if (Array.isArray(nested)) {
      return nested.filter(isRecord) as SellerRecord[]
    }
  }

  return []
}

function resolveSellerModuleService(scope: ScopeResolver): SellerModuleService {
  for (const key of SELLER_SERVICE_KEYS) {
    try {
      const service = scope.resolve(key) as SellerModuleService
      if (
        service &&
        (typeof service.list === "function" ||
          typeof service.listSellers === "function" ||
          typeof service.update === "function" ||
          typeof service.updateSeller === "function" ||
          typeof service.updateSellers === "function")
      ) {
        return service
      }
    } catch {
      // Try the next DI registration key.
    }
  }

  throw new Error("Seller module service is not available in the request scope")
}

async function listSellerRecords(
  service: SellerModuleService,
  filters: Record<string, unknown>,
): Promise<SellerRecord[]> {
  if (typeof service.list === "function") {
    return extractSellerRecords(await service.list(filters))
  }

  if (typeof service.listSellers === "function") {
    return extractSellerRecords(await service.listSellers(filters))
  }

  return []
}

export async function listSellers(
  scope: ScopeResolver,
  filters: Record<string, unknown> = {},
): Promise<SellerRecord[]> {
  const service = resolveSellerModuleService(scope)
  return listSellerRecords(service, filters)
}

export async function getSellerById(
  scope: ScopeResolver,
  id: string,
): Promise<SellerRecord | null> {
  const service = resolveSellerModuleService(scope)

  const filtered = await listSellerRecords(service, { id })
  const directMatch = filtered.find((seller) => seller.id === id)
  if (directMatch) {
    return directMatch
  }

  const sellers = await listSellerRecords(service, {})
  return sellers.find((seller) => seller.id === id) ?? null
}

export async function updateSeller(
  scope: ScopeResolver,
  id: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const service = resolveSellerModuleService(scope)

  if (typeof service.update === "function") {
    await service.update(id, payload)
    return
  }

  if (typeof service.updateSeller === "function") {
    await service.updateSeller(id, payload)
    return
  }

  if (typeof service.updateSellers === "function") {
    await service.updateSellers([{ id, ...payload }])
    return
  }

  throw new Error("Seller module service does not support updates")
}

export function readSellerMetadata(seller: SellerRecord): Record<string, unknown> {
  return isRecord(seller.metadata) ? { ...seller.metadata } : {}
}

export function readSellerGpMetadata(seller: SellerRecord): Record<string, unknown> {
  const metadata = readSellerMetadata(seller)
  return isRecord(metadata.gp) ? { ...(metadata.gp as Record<string, unknown>) } : {}
}

export function mergeSellerGpMetadata(
  seller: SellerRecord,
  gpPatch: Record<string, unknown>,
): Record<string, unknown> {
  const metadata = readSellerMetadata(seller)
  const gp = readSellerGpMetadata(seller)

  return {
    ...metadata,
    gp: {
      ...gp,
      ...gpPatch,
    },
  }
}

export function readLifecycleDecision(
  seller: SellerRecord,
): LifecycleDecisionRecord {
  const gp = readSellerGpMetadata(seller)
  const raw = gp.lifecycle_decision

  if (!isRecord(raw)) {
    return null
  }

  const decision = raw.decision
  if (decision !== "opted_in" && decision !== "opted_out") {
    return null
  }

  return {
    decision,
    reason: typeof raw.reason === "string" ? raw.reason : undefined,
    admin_note: typeof raw.admin_note === "string" ? raw.admin_note : null,
    captured_at: typeof raw.captured_at === "string" ? raw.captured_at : null,
    captured_by: typeof raw.captured_by === "string" ? raw.captured_by : null,
  }
}

export function resolveLifecycleStatus(seller: SellerRecord): LifecycleStatus {
  const gp = readSellerGpMetadata(seller)
  const rawLifecycle = gp.lifecycle_status

  if (
    rawLifecycle === "pending_approval" ||
    rawLifecycle === "open" ||
    rawLifecycle === "suspended" ||
    rawLifecycle === "terminated"
  ) {
    return rawLifecycle
  }

  const rawNativeStatus = typeof seller.status === "string"
    ? seller.status.trim().toLowerCase()
    : ""

  if (
    rawNativeStatus === "pending_approval" ||
    rawNativeStatus === "open" ||
    rawNativeStatus === "suspended" ||
    rawNativeStatus === "terminated"
  ) {
    return rawNativeStatus
  }

  const rawStoreStatus = typeof seller.store_status === "string"
    ? seller.store_status.trim().toUpperCase()
    : ""

  if (rawStoreStatus === "ACTIVE") {
    return "open"
  }

  if (rawStoreStatus === "INACTIVE") {
    return "suspended"
  }

  return "pending_approval"
}

export function resolveDecisionStatus(seller: SellerRecord): DecisionStatus {
  const lifecycleDecision = readLifecycleDecision(seller)
  if (lifecycleDecision) {
    return lifecycleDecision.decision
  }

  const gp = readSellerGpMetadata(seller)
  const rawStatus = gp.decision_status
  if (
    rawStatus === "forced" ||
    rawStatus === "opted_in" ||
    rawStatus === "opted_out"
  ) {
    return rawStatus
  }

  return "pending"
}

export function resolvePreferredLocale(
  seller: SellerRecord,
): DecisionConfirmationLocale {
  const gp = readSellerGpMetadata(seller)
  const candidates = [seller.preferred_locale, gp.preferred_locale]

  for (const candidate of candidates) {
    if (candidate === "en") {
      return "en"
    }
    if (candidate === "pl") {
      return "pl"
    }
  }

  return "pl"
}

export function buildLifecycleMetadataSnapshot(
  seller: SellerRecord,
): VendorMetadataSnapshot {
  const gp = readSellerGpMetadata(seller)
  const lifecycleDecision = readLifecycleDecision(seller)

  return {
    lifecycle_status: resolveLifecycleStatus(seller),
    lifecycle_decision: lifecycleDecision
      ? { decision: lifecycleDecision.decision }
      : null,
    jca_signed_at:
      typeof gp.jca_signed_at === "string" ? gp.jca_signed_at : null,
    training_verified: gp.training_verified === true,
    t30_sent_at:
      typeof gp.t30_sent_at === "string" ? gp.t30_sent_at : null,
    nudges_completed: gp.nudges_completed === true,
  }
}

export function buildDecisionListEntry(seller: SellerRecord): {
  id: string
  handle: string
  email: string
  lifecycle_status: LifecycleStatus
  decision_status: DecisionStatus
  last_action_at: string | null
} {
  const lifecycleDecision = readLifecycleDecision(seller)
  const handle =
    typeof seller.handle === "string" && seller.handle.trim().length > 0
      ? seller.handle
      : seller.id

  return {
    id: seller.id,
    handle,
    email: typeof seller.email === "string" ? seller.email : "",
    lifecycle_status: resolveLifecycleStatus(seller),
    decision_status: resolveDecisionStatus(seller),
    last_action_at: lifecycleDecision?.captured_at ?? null,
  }
}