/**
 * notification-template-registry.ts — runtime'owa warstwa rejestru szablonów
 * (AD-6 allowlist, Story 2.2).
 *
 * Rejestr `specs/contracts/notifications/templates.yaml` jest JEDYNYM źródłem
 * listy szablonów. Ten moduł nie czyta dysku — konsumuje projekcję
 * `notification-template-registry.generated.ts` (codegen + drift-test), więc
 * nadaje się do runtime backendu (bez zależności od super-repo na produkcji).
 *
 * Inwariant AD-6: `buildBrevoTemplateMap()` zwraca WYŁĄCZNIE wpisy rejestru,
 * które mają realne ID szablonu Brevo dla danego locale. Wpis `not_configured`
 * (dziś: wszystkie) NIE trafia do mapy → `BrevoAdapter` kończy fail-loud
 * `BREVO_TEMPLATE_NOT_CONFIGURED`. To zamierzone: uzupełnienie ID to dana
 * operacyjna (panel Brevo), nie decyzja kodu.
 */

import {
  BREVO_TEMPLATE_NOT_CONFIGURED,
  NOTIFICATION_TEMPLATE_KEYS,
  NOTIFICATION_TEMPLATE_REGISTRY,
  type GeneratedNotificationTemplateEntry,
} from "./notification-template-registry.generated";
import type { Locale } from "./types";

export {
  BREVO_TEMPLATE_NOT_CONFIGURED,
  NOTIFICATION_TEMPLATE_KEYS,
  NOTIFICATION_TEMPLATE_REGISTRY,
};
export type { GeneratedNotificationTemplateEntry };

/** Klucz szablonu obecny w rejestrze (allowlist AD-6). */
export type NotificationTemplateKey =
  (typeof NOTIFICATION_TEMPLATE_KEYS)[keyof typeof NOTIFICATION_TEMPLATE_KEYS];

/** Locale rejestru (kolumny mapy `brevo`). */
export type RegistryLocale = "pl" | "ua" | "de" | "en";

/**
 * Mapowanie kanonicznego `Locale` (BCP-47 w `NotificationIntent`) na kolumnę
 * rejestru. Rejestr celowo używa krótkich kodów rynkowych (pl/ua/de/en).
 */
const LOCALE_TO_REGISTRY: Readonly<Record<Locale, RegistryLocale>> = {
  "pl-PL": "pl",
  "uk-UA": "ua",
  "de-DE": "de",
  "en-US": "en",
};

export function toRegistryLocale(locale: Locale): RegistryLocale {
  return LOCALE_TO_REGISTRY[locale];
}

const REGISTRY_BY_KEY: ReadonlyMap<string, GeneratedNotificationTemplateEntry> = new Map(
  NOTIFICATION_TEMPLATE_REGISTRY.map((entry) => [entry.template_key, entry]),
);

/** Czy klucz jest w rejestrze (allowlist AD-6). */
export function isRegisteredTemplateKey(
  templateKey: string,
): templateKey is NotificationTemplateKey {
  return REGISTRY_BY_KEY.has(templateKey);
}

export function findRegistryEntry(
  templateKey: string,
): GeneratedNotificationTemplateEntry | undefined {
  return REGISTRY_BY_KEY.get(templateKey);
}

/**
 * Mapa `templates` dla `BrevoAdapterOptions` w danym locale — WYŁĄCZNIE klucze
 * rejestru ze skonfigurowanym numerycznym ID.
 *
 * Wpis, którego ID nie jest liczbą (`not_configured` albo literówka w rejestrze),
 * jest pomijany świadomie: brak ID w mapie = fail-loud `BREVO_TEMPLATE_NOT_CONFIGURED`
 * po stronie `BrevoAdapter`. Nigdy fallback na „domyślny szablon".
 */
export function buildBrevoTemplateMap(locale: Locale): Record<string, number> {
  const registryLocale = toRegistryLocale(locale);
  const map: Record<string, number> = {};

  for (const entry of NOTIFICATION_TEMPLATE_REGISTRY) {
    const raw = entry.brevo[registryLocale];
    if (!raw || raw === BREVO_TEMPLATE_NOT_CONFIGURED) {
      continue;
    }
    const templateId = Number.parseInt(raw, 10);
    if (!Number.isInteger(templateId) || String(templateId) !== raw.trim()) {
      // Rejestr trzyma ID jako string; wartość nie-numeryczna i nie-sentinel
      // to błąd rejestru — pomijamy (fail-loud przy wysyłce) zamiast zgadywać.
      continue;
    }
    map[entry.template_key] = templateId;
  }

  return map;
}
