/**
 * AUTO-GENERATED — NIE EDYTUJ RĘCZNIE.
 *
 * Projekcja rejestru szablonów notyfikacji (AD-6 allowlist).
 * Źródło prawdy: specs/contracts/notifications/templates.yaml (Story 2.1, ADR-158).
 * Regeneracja: pnpm --filter @gp/messaging gen:notification-templates
 *
 * Drift YAML↔TS jest pilnowany przez
 * packages/messaging/src/__tests__/notification-template-registry.test.ts
 * (regeneruje w pamięci i porównuje treść bajt-w-bajt).
 */

export interface GeneratedNotificationTemplateEntry {
  readonly template_key: string;
  readonly channel: string;
  readonly recipient: string;
  readonly brevo: Readonly<Record<"pl" | "ua" | "de" | "en", string>>;
  readonly status: string;
}

/** Sentinel rejestru: locale bez skonfigurowanego ID szablonu w Brevo. */
export const BREVO_TEMPLATE_NOT_CONFIGURED = "not_configured";

export const NOTIFICATION_TEMPLATE_REGISTRY: readonly GeneratedNotificationTemplateEntry[] = [
  {
    template_key: "voucher_purchase_confirmation",
    channel: "email",
    recipient: "buyer",
    brevo: {
      pl: "not_configured",
      ua: "not_configured",
      de: "not_configured",
      en: "not_configured",
    },
    status: "canonical",
  },
  {
    template_key: "voucher_handoff_link",
    channel: "email",
    recipient: "recipient",
    brevo: {
      pl: "not_configured",
      ua: "not_configured",
      de: "not_configured",
      en: "not_configured",
    },
    status: "canonical",
  },
  {
    template_key: "buyer_claim_notification",
    channel: "email",
    recipient: "buyer",
    brevo: {
      pl: "not_configured",
      ua: "not_configured",
      de: "not_configured",
      en: "not_configured",
    },
    status: "legacy_active",
  },
  {
    template_key: "voucher_appointment_confirmation",
    channel: "email",
    recipient: "buyer",
    brevo: {
      pl: "not_configured",
      ua: "not_configured",
      de: "not_configured",
      en: "not_configured",
    },
    status: "legacy_active",
  },
  {
    template_key: "t30_migration",
    channel: "email",
    recipient: "vendor",
    brevo: {
      pl: "not_configured",
      ua: "not_configured",
      de: "not_configured",
      en: "not_configured",
    },
    status: "legacy_active",
  },
  {
    template_key: "vendor-decision-confirmation",
    channel: "email",
    recipient: "vendor",
    brevo: {
      pl: "not_configured",
      ua: "not_configured",
      de: "not_configured",
      en: "not_configured",
    },
    status: "legacy_active",
  },
  {
    template_key: "customer-recover-magic-link",
    channel: "email",
    recipient: "buyer",
    brevo: {
      pl: "not_configured",
      ua: "not_configured",
      de: "not_configured",
      en: "not_configured",
    },
    status: "legacy_active",
  },
  {
    template_key: "dispatch_vendor_email_dynamic",
    channel: "email",
    recipient: "vendor",
    brevo: {
      pl: "not_configured",
      ua: "not_configured",
      de: "not_configured",
      en: "not_configured",
    },
    status: "dynamic_class",
  },
];

/**
 * Stałe kluczy — JEDYNA dozwolona forma odwołania do szablonu w kodzie
 * produkcyjnym (literały w call-site'ach = drugie źródło prawdy, łamie AD-6).
 */
export const NOTIFICATION_TEMPLATE_KEYS = {
  VOUCHER_PURCHASE_CONFIRMATION: "voucher_purchase_confirmation",
  VOUCHER_HANDOFF_LINK: "voucher_handoff_link",
  BUYER_CLAIM_NOTIFICATION: "buyer_claim_notification",
  VOUCHER_APPOINTMENT_CONFIRMATION: "voucher_appointment_confirmation",
  T30_MIGRATION: "t30_migration",
  VENDOR_DECISION_CONFIRMATION: "vendor-decision-confirmation",
  CUSTOMER_RECOVER_MAGIC_LINK: "customer-recover-magic-link",
  DISPATCH_VENDOR_EMAIL_DYNAMIC: "dispatch_vendor_email_dynamic",
} as const;
