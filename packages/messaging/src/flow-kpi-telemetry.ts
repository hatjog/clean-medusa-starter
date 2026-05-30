import { createHash } from "node:crypto";

const browserGlobal = globalThis as { window?: unknown; document?: unknown };
if (typeof browserGlobal.window !== "undefined" || typeof browserGlobal.document !== "undefined") {
  throw new Error("@gp/messaging/flow-kpi-telemetry is server-only.");
}

export const FLOW_KPI_NAMES = [
  "delivered_rate",
  "click_to_claim",
  "opt_out",
  "time_to_delivery",
  "support_contact",
] as const;

export type FlowKpiName = (typeof FLOW_KPI_NAMES)[number];

export const FLOW_KPI_EVENT_NAMES: Record<FlowKpiName, string> = {
  delivered_rate: "gp.messaging.flow_kpi.delivered_rate",
  click_to_claim: "gp.messaging.flow_kpi.click_to_claim",
  opt_out: "gp.messaging.flow_kpi.opt_out",
  time_to_delivery: "gp.messaging.flow_kpi.time_to_delivery",
  support_contact: "gp.messaging.flow_kpi.support_contact",
};

export const FLOW_KPI_GATED_EVENT_NAME = "gp.messaging.flow_kpi.gated";
export const FLOW_KPI_NFR20_ALERT_EVENT_NAME =
  "gp.messaging.flow_kpi.nfr20_regression_alert";

// I2: próg NFR20 jest wyrażony w PUNKTACH PROCENTOWYCH (absolutna różnica
// delivery-rate baseline − rolling), NIE jako 5% względne. `adjusted_regression > 0.05`
// znaczy "spadek o ponad 5 pp". Spójne z R20 (architecture.md:2252) i artefaktami
// (alert `semantics: percentage_points_absolute`). PRD §5.3 zapisuje to skrótowo jako ">5%".
export const NFR20_REGRESSION_THRESHOLD_PCT = 5 as const;
const NFR20_REGRESSION_THRESHOLD_FRACTION = 0.05;

const APPROVER_ROLES = [
  "business",
  "copy",
  "platform",
  "compliance",
  "market",
] as const;

export type FlowApprovalRole = (typeof APPROVER_ROLES)[number];
export type FlowApprovalStatus = "green" | "pending" | "rejected";

export type FlowLifecycleState = "rolled_out" | "rolled_back";

export interface FlowApprovalRoleEntry {
  status: FlowApprovalStatus;
  approver?: string;
  approved_at?: string;
}

export interface FlowApprovalEntry {
  governed_fields_digest?: string;
  // M3: jawny stan lifecycle z kontraktu 5-8. Brak pola == `rolled_out`
  // (kontrakt: 5-role green = approved & rolled-out). `rolled_back` wyklucza
  // emisję KPI mimo historycznie zielonych ról.
  lifecycle_state?: FlowLifecycleState;
  roles?: Partial<Record<FlowApprovalRole, FlowApprovalRoleEntry>>;
}

export type FlowApprovalLookup = (
  market: string,
  flowId: string,
) => FlowApprovalEntry | null | undefined;

export interface PostHogCaptureClient {
  capture(input: {
    distinctId: string;
    event: string;
    properties: Record<string, unknown>;
    // M1: top-level `uuid` włącza natywną deduplikację PostHog (przeżywa restart
    // procesu / drugą instancję), czego in-memory `Set` nie gwarantuje.
    uuid?: string;
  }): void;
  shutdown?(): Promise<void>;
  flush?(): Promise<void>;
}

export type CommunicationKpiSourceEventType =
  | "sent"
  | "delivered"
  | "clicked"
  | "claim"
  | "unsubscribed"
  | "support_contact";

export interface CommunicationKpiSourceEvent {
  source: "normalized_event_store" | "delivery_audit_envelope";
  event_id: string;
  event_type: CommunicationKpiSourceEventType;
  occurred_at: string;
  flow_id: string;
  market: string;
  locale: string;
  recipient_hash?: string;
  dispatch_time?: string;
  provider_timestamp?: string;
  idempotency_key?: string;
  provider?: "brevo" | "resend" | "none" | string;
  outcome?: string;
  // M3: digest governed-fields aktualnie wdrożonej treści flow. Gdy podany,
  // gate porównuje go z zatwierdzonym `governed_fields_digest` z kontraktu 5-8
  // i wyklucza emisję przy dryfcie post-approval.
  governed_fields_digest?: string;
  properties?: Record<string, unknown>;
}

export type FlowRegistryStatus =
  | "approved"
  | "unapproved"
  | "unknown"
  | "contract_missing"
  | "governed_fields_drift"
  | "rolled_back";

export interface FlowApprovalDecision {
  status: FlowRegistryStatus;
  missing_roles: FlowApprovalRole[];
  telemetry_excluded: boolean;
}

export interface FlowKpiPostHogEvent {
  distinctId: string;
  event: string;
  properties: Record<string, unknown>;
  idempotencyKey: string;
}

export interface FlowKpiEmissionResult {
  emitted: FlowKpiPostHogEvent[];
  skipped_duplicate: string[];
  // M2: zdarzenia których NIE oznaczono jako wyemitowane (brak klienta lub błąd
  // wysyłki) — klucz NIE jest spalony w dedupeStore, więc ponowne przetworzenie
  // (np. po skonfigurowaniu klienta) wyemituje je bez utraty KPI.
  not_emitted: string[];
  gated: boolean;
  flow_registry_status: FlowRegistryStatus;
  missing_roles: FlowApprovalRole[];
}

export interface FlowKpiEmitterOptions {
  client?: PostHogCaptureClient | null;
  approvalLookup?: FlowApprovalLookup;
  dedupeStore?: Set<string>;
  now?: () => Date;
  // M3: obserwowany digest governed-fields wdrożonego flow (gdy nie podany w
  // sourceEvent). Mismatch względem kontraktu 5-8 → wykluczenie (drift).
  governedFieldsDigest?: string;
}

export interface Nfr20BaselineMarket {
  market: string;
  sent: number;
  delivered: number;
  delivery_rate: number;
  window_days: 7;
  sample_floor: number;
  provider: "brevo";
  control_group?: boolean;
}

export interface Nfr20RollingMarketWindow {
  market: string;
  sent: number;
  delivered: number;
  window_days: 7;
  window_started_at: string;
  window_ended_at: string;
}

export interface Nfr20ControlDelta {
  market: string;
  baseline_delivery_rate: number;
  rolling_delivery_rate: number;
}

export type Nfr20GuardStatus = "pass" | "alert" | "insufficient_sample";

export interface Nfr20GuardResult {
  market: string;
  status: Nfr20GuardStatus;
  baseline_delivery_rate: number;
  rolling_delivery_rate: number;
  raw_regression_pct: number;
  control_delta_pct: number;
  adjusted_regression_pct: number;
  threshold_pct: 5;
  sample_n: number;
  sample_floor: number;
  outcome: "pass" | "fail" | "suppressed";
}

let posthogClient: PostHogCaptureClient | null = null;
let envInitAttempted = false;
const defaultDedupeStore = new Set<string>();

export function setFlowKpiPostHogClient(client: PostHogCaptureClient | null): void {
  posthogClient = client;
  if (client !== null) envInitAttempted = true;
}

export function resetFlowKpiPostHogEnvInit(): void {
  envInitAttempted = false;
}

export async function shutdownFlowKpiPostHogClient(): Promise<void> {
  const client = posthogClient;
  posthogClient = null;
  envInitAttempted = false;
  if (!client) return;
  if (typeof client.shutdown === "function") {
    await client.shutdown();
    return;
  }
  if (typeof client.flush === "function") {
    await client.flush();
  }
}

export function __resetFlowKpiTelemetryForTests(): void {
  posthogClient = null;
  envInitAttempted = false;
  defaultDedupeStore.clear();
}

export function classifyFlowApproval(
  market: string,
  flowId: string,
  approvalLookup?: FlowApprovalLookup,
  observedGovernedFieldsDigest?: string,
): FlowApprovalDecision {
  if (!approvalLookup) {
    return {
      status: "contract_missing",
      missing_roles: [...APPROVER_ROLES],
      telemetry_excluded: true,
    };
  }

  let entry: FlowApprovalEntry | null | undefined;
  try {
    entry = approvalLookup(market, flowId);
  } catch {
    return {
      status: "contract_missing",
      missing_roles: [...APPROVER_ROLES],
      telemetry_excluded: true,
    };
  }

  if (!entry) {
    return {
      status: "unknown",
      missing_roles: [...APPROVER_ROLES],
      telemetry_excluded: true,
    };
  }

  const missing = APPROVER_ROLES.filter((role) => {
    const approval = entry?.roles?.[role];
    return approval?.status !== "green" || !approval.approver || !approval.approved_at;
  });

  if (missing.length > 0) {
    return { status: "unapproved", missing_roles: missing, telemetry_excluded: true };
  }

  // M3: flow wycofany (rolled-back) nie emituje KPI mimo zielonych ról.
  if (entry.lifecycle_state === "rolled_back") {
    return { status: "rolled_back", missing_roles: [], telemetry_excluded: true };
  }

  // M3: egzekwuj governed_fields_digest z kontraktu 5-8 — jeśli zatwierdzony digest
  // istnieje, a obserwowana treść flow ma inny digest, to post-approval drift
  // (dokładnie scenariusz, przed którym digest chroni) → wyklucz emisję.
  if (
    entry.governed_fields_digest &&
    observedGovernedFieldsDigest &&
    entry.governed_fields_digest !== observedGovernedFieldsDigest
  ) {
    return {
      status: "governed_fields_drift",
      missing_roles: [],
      telemetry_excluded: true,
    };
  }

  return { status: "approved", missing_roles: [], telemetry_excluded: false };
}

export function emitFlowKpiTelemetry(
  sourceEvent: CommunicationKpiSourceEvent,
  options: FlowKpiEmitterOptions = {},
): FlowKpiEmissionResult {
  assertNormalizedSource(sourceEvent);
  assertNoRawPii(sourceEvent);

  const client = options.client ?? posthogClient ?? createPostHogClientFromEnv();
  const dedupeStore = options.dedupeStore ?? defaultDedupeStore;
  const observedDigest =
    options.governedFieldsDigest ?? sourceEvent.governed_fields_digest;
  const decision = classifyFlowApproval(
    sourceEvent.market,
    sourceEvent.flow_id,
    options.approvalLookup,
    observedDigest,
  );

  const emitted: FlowKpiPostHogEvent[] = [];
  const skippedDuplicate: string[] = [];
  const notEmitted: string[] = [];

  if (decision.telemetry_excluded) {
    const gated = buildGatedEvent(sourceEvent, decision, options.now?.() ?? new Date());
    captureIfUnique(client, dedupeStore, gated, emitted, skippedDuplicate, notEmitted);
    return {
      emitted,
      skipped_duplicate: skippedDuplicate,
      not_emitted: notEmitted,
      gated: true,
      flow_registry_status: decision.status,
      missing_roles: decision.missing_roles,
    };
  }

  for (const event of buildKpiEvents(sourceEvent)) {
    captureIfUnique(client, dedupeStore, event, emitted, skippedDuplicate, notEmitted);
  }

  return {
    emitted,
    skipped_duplicate: skippedDuplicate,
    not_emitted: notEmitted,
    gated: false,
    flow_registry_status: decision.status,
    missing_roles: [],
  };
}

export function evaluateNfr20Guard(
  baseline: Nfr20BaselineMarket,
  rolling: Nfr20RollingMarketWindow,
  controls: Nfr20ControlDelta[] = [],
): Nfr20GuardResult {
  const sampleFloor = baseline.sample_floor;
  const rollingRate = rate(rolling.delivered, rolling.sent);
  const rawRegression = baseline.delivery_rate - rollingRate;
  const controlDelta = controls.length
    ? controls.reduce(
        (sum, control) =>
          sum + (control.rolling_delivery_rate - control.baseline_delivery_rate),
        0,
      ) / controls.length
    : 0;
  const adjustedRegression = rawRegression + controlDelta;

  if (rolling.sent < sampleFloor || baseline.sent < sampleFloor) {
    return {
      market: rolling.market,
      status: "insufficient_sample",
      baseline_delivery_rate: baseline.delivery_rate,
      rolling_delivery_rate: rollingRate,
      raw_regression_pct: roundPct(rawRegression),
      control_delta_pct: roundPct(controlDelta),
      adjusted_regression_pct: roundPct(adjustedRegression),
      threshold_pct: 5,
      sample_n: rolling.sent,
      sample_floor: sampleFloor,
      outcome: "suppressed",
    };
  }

  const status: Nfr20GuardStatus =
    adjustedRegression > NFR20_REGRESSION_THRESHOLD_FRACTION ? "alert" : "pass";

  return {
    market: rolling.market,
    status,
    baseline_delivery_rate: baseline.delivery_rate,
    rolling_delivery_rate: rollingRate,
    raw_regression_pct: roundPct(rawRegression),
    control_delta_pct: roundPct(controlDelta),
    adjusted_regression_pct: roundPct(adjustedRegression),
    threshold_pct: 5,
    sample_n: rolling.sent,
    sample_floor: sampleFloor,
    outcome: status === "alert" ? "fail" : "pass",
  };
}

export function emitNfr20GuardResult(
  result: Nfr20GuardResult,
  client: PostHogCaptureClient | null = posthogClient ?? createPostHogClientFromEnv(),
): boolean {
  if (!client || result.status !== "alert") return false;
  const idempotencyKey = sha256Hex([
    "flow-kpi-nfr20",
    result.market,
    result.adjusted_regression_pct,
  ]);
  client.capture({
    distinctId: `market:${result.market}`,
    event: FLOW_KPI_NFR20_ALERT_EVENT_NAME,
    uuid: deterministicEventUuid(idempotencyKey),
    properties: {
      market: result.market,
      flow_id: "__all_flows__",
      locale: "__all__",
      outcome: result.outcome,
      baseline_delivery_rate: result.baseline_delivery_rate,
      rolling_delivery_rate: result.rolling_delivery_rate,
      raw_regression_pct: result.raw_regression_pct,
      control_delta_pct: result.control_delta_pct,
      adjusted_regression_pct: result.adjusted_regression_pct,
      threshold_pct: result.threshold_pct,
      sample_n: result.sample_n,
      sample_floor: result.sample_floor,
      window_days: 7,
      $insert_id: idempotencyKey,
    },
  });
  return true;
}

// H1 (AC3): scheduler/cron hook — wykonuje guard NFR20 na oknie rolling 7d per
// rynek i emituje alert tylko gdy status=alert. To realny konsument
// `evaluateNfr20Guard`/`emitNfr20GuardResult` (cron job woła tę funkcję na danych
// z baseline + rolling window store).
export interface Nfr20GuardSweepInput {
  baselines: Nfr20BaselineMarket[];
  rollingWindows: Nfr20RollingMarketWindow[];
  controls?: Nfr20ControlDelta[];
}

export interface Nfr20GuardSweepResult {
  results: Nfr20GuardResult[];
  alerts_emitted: number;
}

export function runNfr20GuardSweep(
  input: Nfr20GuardSweepInput,
  client: PostHogCaptureClient | null = posthogClient ?? createPostHogClientFromEnv(),
): Nfr20GuardSweepResult {
  const baselineByMarket = new Map(input.baselines.map((b) => [b.market, b]));
  const controls = input.controls ?? deriveControlDeltas(input);
  const results: Nfr20GuardResult[] = [];
  let alertsEmitted = 0;

  for (const rolling of input.rollingWindows) {
    const baseline = baselineByMarket.get(rolling.market);
    if (!baseline) continue;
    // Rynki kontrolne nie alertują na własnym delcie — służą wyłącznie jako
    // proxy sezonowości dla rynków produkcyjnych.
    const marketControls = controls.filter((c) => c.market !== rolling.market);
    const result = evaluateNfr20Guard(baseline, rolling, marketControls);
    results.push(result);
    if (emitNfr20GuardResult(result, client)) alertsEmitted += 1;
  }

  return { results, alerts_emitted: alertsEmitted };
}

function deriveControlDeltas(input: Nfr20GuardSweepInput): Nfr20ControlDelta[] {
  const rollingByMarket = new Map(input.rollingWindows.map((r) => [r.market, r]));
  const deltas: Nfr20ControlDelta[] = [];
  for (const baseline of input.baselines) {
    if (baseline.control_group !== true) continue;
    const rolling = rollingByMarket.get(baseline.market);
    if (!rolling) continue;
    deltas.push({
      market: baseline.market,
      baseline_delivery_rate: baseline.delivery_rate,
      rolling_delivery_rate: rate(rolling.delivered, rolling.sent),
    });
  }
  return deltas;
}

// H1 (AC1): hook telemetryczny wstrzykiwany do messaging-gateway. Sprawia, że
// `emitFlowKpiTelemetry` jest realnie wołany w lifecycle wysyłki/eventów (gateway
// `send()` + `recordDeliveryEvent()`), a nie pozostaje martwym kodem biblioteki.
// Trwały dedupeStore współdzielony per-proces; natywny dedup PostHog (uuid) chroni
// cross-proces (M1).
export interface FlowKpiTelemetryHook {
  emit(sourceEvent: CommunicationKpiSourceEvent): FlowKpiEmissionResult;
}

export interface CreateFlowKpiTelemetryHookOptions {
  approvalLookup?: FlowApprovalLookup;
  client?: PostHogCaptureClient | null;
  dedupeStore?: Set<string>;
  now?: () => Date;
}

export function createFlowKpiTelemetryHook(
  options: CreateFlowKpiTelemetryHookOptions = {},
): FlowKpiTelemetryHook {
  const dedupeStore = options.dedupeStore ?? new Set<string>();
  return {
    emit(sourceEvent: CommunicationKpiSourceEvent): FlowKpiEmissionResult {
      return emitFlowKpiTelemetry(sourceEvent, {
        client: options.client,
        approvalLookup: options.approvalLookup,
        dedupeStore,
        now: options.now,
      });
    },
  };
}

function buildKpiEvents(sourceEvent: CommunicationKpiSourceEvent): FlowKpiPostHogEvent[] {
  const common = commonProperties(sourceEvent);
  const events: FlowKpiPostHogEvent[] = [];

  if (sourceEvent.event_type === "sent") {
    events.push(kpiEvent(sourceEvent, "delivered_rate", "sent", common));
  }

  if (sourceEvent.event_type === "delivered") {
    events.push(kpiEvent(sourceEvent, "delivered_rate", "delivered", common));
    events.push(kpiEvent(sourceEvent, "opt_out", "delivered", common));

    const durationMs = deliveryDurationMs(sourceEvent);
    if (durationMs !== null) {
      events.push(
        kpiEvent(sourceEvent, "time_to_delivery", "delivered", {
          ...common,
          duration_ms: durationMs,
        }),
      );
    }
  }

  if (sourceEvent.event_type === "clicked") {
    events.push(kpiEvent(sourceEvent, "click_to_claim", "click", common));
  }

  if (sourceEvent.event_type === "claim") {
    events.push(kpiEvent(sourceEvent, "click_to_claim", "claim", common));
  }

  if (sourceEvent.event_type === "unsubscribed") {
    events.push(kpiEvent(sourceEvent, "opt_out", "unsubscribe", common));
  }

  if (sourceEvent.event_type === "support_contact") {
    events.push(kpiEvent(sourceEvent, "support_contact", "support_contact", common));
  }

  return events;
}

function kpiEvent(
  sourceEvent: CommunicationKpiSourceEvent,
  kpi: FlowKpiName,
  outcome: string,
  properties: Record<string, unknown>,
): FlowKpiPostHogEvent {
  const idempotencyKey = buildIdempotencyKey(sourceEvent, kpi, outcome);
  return {
    distinctId: buildDistinctId(sourceEvent),
    event: FLOW_KPI_EVENT_NAMES[kpi],
    idempotencyKey,
    properties: {
      ...properties,
      kpi,
      outcome,
      idempotency_key: idempotencyKey,
    },
  };
}

function buildGatedEvent(
  sourceEvent: CommunicationKpiSourceEvent,
  decision: FlowApprovalDecision,
  now: Date,
): FlowKpiPostHogEvent {
  // I1: spójny format idempotency key z eventami KPI (sha256), zamiast plain join.
  const idempotencyKey = sha256Hex([
    "flow-kpi-gated",
    sourceEvent.market,
    sourceEvent.flow_id,
    sourceEvent.event_id,
    decision.status,
  ]);

  return {
    distinctId: buildDistinctId(sourceEvent),
    event: FLOW_KPI_GATED_EVENT_NAME,
    idempotencyKey,
    properties: {
      ...commonProperties(sourceEvent),
      outcome: sourceEvent.outcome ?? sourceEvent.event_type,
      flow_registry_status: decision.status,
      flow_registry_missing_roles: decision.missing_roles,
      telemetry_excluded: true,
      gated_at: now.toISOString(),
      idempotency_key: idempotencyKey,
    },
  };
}

function commonProperties(sourceEvent: CommunicationKpiSourceEvent): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    flow_id: sourceEvent.flow_id,
    market: sourceEvent.market,
    locale: sourceEvent.locale,
    source: sourceEvent.source,
    source_event_id: sourceEvent.event_id,
    source_event_type: sourceEvent.event_type,
    occurred_at: sourceEvent.occurred_at,
  };

  if (sourceEvent.provider) properties.provider = sourceEvent.provider;
  if (sourceEvent.recipient_hash) {
    properties.recipient_hash = normalizeRecipientHash(sourceEvent.recipient_hash);
  }

  return properties;
}

function captureIfUnique(
  client: PostHogCaptureClient | null,
  dedupeStore: Set<string>,
  event: FlowKpiPostHogEvent,
  emitted: FlowKpiPostHogEvent[],
  skippedDuplicate: string[],
  notEmitted: string[],
): void {
  if (dedupeStore.has(event.idempotencyKey)) {
    skippedDuplicate.push(event.idempotencyKey);
    return;
  }

  // L2: skanuj PII na FINALNYM obiekcie properties, który realnie trafia do PostHog,
  // nie tylko na wejściowym (i nieemitowanym) bagu sourceEvent.properties.
  assertPropertiesNoRawPii(event.properties);

  // M2: brak klienta (graceful degradation, np. brak POSTHOG_API_KEY) NIE spala klucza
  // dedup ani nie oznacza eventu jako wyemitowanego — po późniejszym skonfigurowaniu
  // klienta to samo źródłowe zdarzenie zostanie wyemitowane (brak silent loss KPI).
  if (!client) {
    notEmitted.push(event.idempotencyKey);
    return;
  }

  try {
    client.capture({
      distinctId: event.distinctId,
      event: event.event,
      // M1: natywny dedup PostHog po uuid (+ $insert_id) — odporne na restart/instancje.
      uuid: deterministicEventUuid(event.idempotencyKey),
      properties: {
        ...event.properties,
        $insert_id: event.idempotencyKey,
      },
    });
  } catch {
    // M2: wysyłka się nie powiodła → NIE oznaczaj jako skonsumowane (umożliw retry).
    notEmitted.push(event.idempotencyKey);
    return;
  }

  // Oznacz dopiero po udanej wysyłce.
  dedupeStore.add(event.idempotencyKey);
  emitted.push(event);
}

function buildDistinctId(sourceEvent: CommunicationKpiSourceEvent): string {
  if (sourceEvent.recipient_hash) return normalizeRecipientHash(sourceEvent.recipient_hash);
  return `flow:${sourceEvent.market}:${sourceEvent.flow_id}`;
}

function buildIdempotencyKey(
  sourceEvent: CommunicationKpiSourceEvent,
  kpi: FlowKpiName,
  outcome: string,
): string {
  return sha256Hex([
    "flow-kpi",
    sourceEvent.idempotency_key ?? sourceEvent.event_id,
    sourceEvent.market,
    sourceEvent.flow_id,
    kpi,
    outcome,
  ]);
}

function sha256Hex(parts: (string | number)[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

// M1: deterministyczny UUID (v8-style) wyprowadzony z idempotency key, by PostHog
// natywnie deduplikował to samo źródłowe zdarzenie niezależnie od in-memory store.
function deterministicEventUuid(idempotencyKey: string): string {
  const hex = createHash("sha256").update(idempotencyKey).digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

function normalizeRecipientHash(value: string): string {
  return value.startsWith("sha256:") ? value : `sha256:${value}`;
}

function deliveryDurationMs(sourceEvent: CommunicationKpiSourceEvent): number | null {
  const start = Date.parse(sourceEvent.dispatch_time ?? "");
  const end = Date.parse(sourceEvent.provider_timestamp ?? sourceEvent.occurred_at);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
}

function assertNormalizedSource(sourceEvent: CommunicationKpiSourceEvent): void {
  if (
    sourceEvent.source !== "normalized_event_store" &&
    sourceEvent.source !== "delivery_audit_envelope"
  ) {
    throw new Error("flow KPI telemetry accepts only normalized event-store sources");
  }
}

function assertNoRawPii(sourceEvent: CommunicationKpiSourceEvent): void {
  assertPropertiesNoRawPii(sourceEvent.properties ?? {});
}

function assertPropertiesNoRawPii(properties: Record<string, unknown>): void {
  if (containsRawPii(JSON.stringify(properties))) {
    throw new Error("flow KPI telemetry properties must not contain raw PII");
  }
}

function containsRawPii(payload: string): boolean {
  // L1/L2: zanim sprawdzisz wzorzec telefonu, usuń ze stringa tokeny strukturalne,
  // które legalnie zawierają długie ciągi cyfr i dawałyby false-positive:
  //  - zahashowane identyfikatory (`sha256:<hex>` oraz bare 64-hex) — L1,
  //  - timestampy ISO-8601 (occurred_at itp.) — emitowane properties je zawierają (L2).
  // E-mail (zawiera `@`, którego hash/timestamp nie ma) sprawdzamy na surowym tekście.
  if (/@/.test(payload)) return true;
  const sanitized = payload
    .replace(/sha256:[a-f0-9]+/gi, "")
    .replace(/\b[a-f0-9]{64}\b/gi, "")
    .replace(/\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)?/g, "");
  return /\b\+?\d[\d\s.-]{7,}\d\b/.test(sanitized);
}

function rate(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return numerator / denominator;
}

function roundPct(value: number): number {
  return Math.round(value * 10000) / 100;
}

function createPostHogClientFromEnv(): PostHogCaptureClient | null {
  if (envInitAttempted) return posthogClient;
  envInitAttempted = true;

  const apiKey = process.env.POSTHOG_API_KEY;
  if (!apiKey) return null;

  const { PostHog } = require("posthog-node") as {
    PostHog: new (
      key: string,
      options?: { host?: string; flushAt?: number; flushInterval?: number },
    ) => PostHogCaptureClient;
  };
  posthogClient = new PostHog(apiKey, {
    host: process.env.POSTHOG_HOST,
    flushAt: 1,
    flushInterval: 0,
  });
  return posthogClient;
}
