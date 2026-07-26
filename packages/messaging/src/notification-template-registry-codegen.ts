/**
 * notification-template-registry-codegen.ts — renderer projekcji rejestru
 * szablonów (YAML → TS).
 *
 * Story 2.2 (v1.14.0, AD-6). Wydzielony z `scripts/generate-notification-template-registry.ts`,
 * żeby drift-test mógł zregenerować treść w pamięci i porównać ją z plikiem
 * zacommitowanym (bez odpalania procesu build). Moduł czyta z dysku i NIE jest
 * eksportowany z `index.ts` — nie należy do powierzchni runtime.
 */

import { readFileSync } from "node:fs";

import { load as loadYaml } from "js-yaml";

export const REGISTRY_YAML_SUBPATH = "specs/contracts/notifications/templates.yaml";
export const GENERATED_FILE_SUBPATH = "src/notification-template-registry.generated.ts";

/** Locale rejestru (AD-6, schema notification-templates.v1). */
export const REGISTRY_LOCALES = ["pl", "ua", "de", "en"] as const;

export type RegistryLocale = (typeof REGISTRY_LOCALES)[number];

export interface RawRegistryEntry {
  template_key: string;
  channel: string;
  recipient: string;
  brevo: Record<string, string>;
  owner: string;
  status: string;
  source?: string;
  notes?: string;
}

interface RawRegistry {
  schema_version?: unknown;
  contract?: unknown;
  version?: unknown;
  owner?: unknown;
  templates?: unknown;
}

/**
 * Identyfikator stałej TS dla klucza rejestru. Zastane klucze kebab-case
 * (`vendor-decision-confirmation`) i snake_case (`t30_migration`) sprowadzamy
 * do jednej formy UPPER_SNAKE — sam `template_key` pozostaje verbatim
 * (ADR-158: żaden zastany klucz nie znika i nie jest po cichu przemianowany).
 */
export function constantIdentifierFor(templateKey: string): string {
  const ident = templateKey.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase();
  if (!/^[A-Z][A-Z0-9_]*$/.test(ident)) {
    throw new Error(
      `[notification-template-registry] template_key '${templateKey}' nie mapuje się na poprawny identyfikator TS ('${ident}')`,
    );
  }
  return ident;
}

export function readRegistryEntries(yamlPath: string): RawRegistryEntry[] {
  let text: string;
  try {
    text = readFileSync(yamlPath, "utf8");
  } catch (error) {
    throw new Error(
      `[notification-template-registry] nie można odczytać rejestru '${yamlPath}'. ` +
        "Rejestr żyje w super-repo GP (poza submodułem GP/backend) — codegen i drift-test " +
        `wymagają kontekstu monorepo. Przyczyna: ${(error as Error).message}`,
    );
  }

  const parsed = loadYaml(text) as RawRegistry | undefined;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`[notification-template-registry] '${yamlPath}': oczekiwano mapowania YAML`);
  }
  if (parsed.contract !== "gp.notifications.templates") {
    throw new Error(
      `[notification-template-registry] '${yamlPath}': nieoczekiwany contract '${String(parsed.contract)}'`,
    );
  }

  const entries = parsed.templates;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(
      `[notification-template-registry] '${yamlPath}': templates musi być niepustą listą`,
    );
  }

  return entries.map((entry, index) => {
    const record = entry as Partial<RawRegistryEntry>;
    const key = record.template_key;
    if (typeof key !== "string" || !key) {
      throw new Error(
        `[notification-template-registry] templates[${index}]: brak template_key`,
      );
    }
    const brevo = record.brevo;
    if (!brevo || typeof brevo !== "object") {
      throw new Error(`[notification-template-registry] ${key}: brak mapowania brevo`);
    }
    for (const locale of REGISTRY_LOCALES) {
      if (typeof brevo[locale] !== "string" || !brevo[locale]) {
        throw new Error(
          `[notification-template-registry] ${key}: brevo.${locale} musi być ID szablonu albo 'not_configured'`,
        );
      }
    }
    return {
      template_key: key,
      channel: String(record.channel),
      recipient: String(record.recipient),
      brevo: Object.fromEntries(
        REGISTRY_LOCALES.map((locale) => [locale, brevo[locale] as string]),
      ),
      owner: String(record.owner),
      status: String(record.status),
      source: record.source,
      notes: record.notes,
    };
  });
}

function quote(value: string): string {
  return JSON.stringify(value);
}

/** Renderuje pełną treść pliku `notification-template-registry.generated.ts`. */
export function renderGeneratedRegistry(yamlPath: string): string {
  const entries = readRegistryEntries(yamlPath);

  const registryLines = entries
    .map((entry) => {
      const brevo = REGISTRY_LOCALES.map(
        (locale) => `      ${locale}: ${quote(entry.brevo[locale])},`,
      ).join("\n");
      return [
        "  {",
        `    template_key: ${quote(entry.template_key)},`,
        `    channel: ${quote(entry.channel)},`,
        `    recipient: ${quote(entry.recipient)},`,
        "    brevo: {",
        brevo,
        "    },",
        `    status: ${quote(entry.status)},`,
        "  },",
      ].join("\n");
    })
    .join("\n");

  const keyLines = entries
    .map(
      (entry) =>
        `  ${constantIdentifierFor(entry.template_key)}: ${quote(entry.template_key)},`,
    )
    .join("\n");

  return `/**
 * AUTO-GENERATED — NIE EDYTUJ RĘCZNIE.
 *
 * Projekcja rejestru szablonów notyfikacji (AD-6 allowlist).
 * Źródło prawdy: ${REGISTRY_YAML_SUBPATH} (Story 2.1, ADR-158).
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
${registryLines}
];

/**
 * Stałe kluczy — JEDYNA dozwolona forma odwołania do szablonu w kodzie
 * produkcyjnym (literały w call-site'ach = drugie źródło prawdy, łamie AD-6).
 */
export const NOTIFICATION_TEMPLATE_KEYS = {
${keyLines}
} as const;
`;
}
