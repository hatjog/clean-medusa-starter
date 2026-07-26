/**
 * registry-backed-brevo-provider.ts — provider `brevo` z mapą szablonów
 * generowaną z rejestru (AD-6, Story 2.2).
 *
 * Po co osobna klasa zamiast gołego `BrevoAdapter`:
 * `BrevoAdapterOptions.templates` jest płaską mapą `template_key → templateId`,
 * a rejestr trzyma ID **per locale** (pl/ua/de/en). Ten provider trzyma po
 * jednym `BrevoAdapter` na locale (mapa z `buildBrevoTemplateMap`) i wybiera go
 * na podstawie `intent.locale`. Zero duplikacji budowy payloadu Brevo — cała
 * logika mapowania pozostaje w `BrevoAdapter`.
 *
 * Allowlist: mapa pochodzi WYŁĄCZNIE z rejestru, więc klucz spoza rejestru
 * (albo klucz z rejestru z `not_configured`) kończy się fail-loud
 * `BREVO_TEMPLATE_NOT_CONFIGURED` w `BrevoAdapter.toBrevoPayload`.
 */

import { buildBrevoTemplateMap } from "../notification-template-registry";
import type { IMessagingProvider, MessagingProviderResponse } from "../provider";
import type { Locale, NotificationIntent } from "../types";
import { BrevoAdapter } from "./brevo-adapter";
import type { BrevoEmailAddress, IBrevoClient } from "./brevo-client";

export interface RegistryBackedBrevoProviderOptions {
  /** `market_id → sender` (bez hardcodowanych adresów — źródłem jest env/config). */
  senders: Record<string, BrevoEmailAddress>;
  clock?: () => Date;
  uuid?: () => string;
  /**
   * Seam testowy (jak `clock`/`uuid`): pozwala testom odegrać stan „operator
   * uzupełnił ID w rejestrze" bez zgadywania ID w samym rejestrze YAML.
   * Produkcyjnie ZAWSZE `buildBrevoTemplateMap` — czyli wyłącznie rejestr.
   */
  templateMapFor?: (locale: Locale) => Record<string, number>;
}

export class RegistryBackedBrevoProvider implements IMessagingProvider {
  readonly key = "brevo" as const;

  private readonly adapters = new Map<Locale, BrevoAdapter>();

  constructor(
    private readonly client: IBrevoClient,
    private readonly options: RegistryBackedBrevoProviderOptions,
  ) {}

  async send(intent: NotificationIntent): Promise<MessagingProviderResponse> {
    return this.adapterFor(intent.locale).send(intent);
  }

  /** Mapa szablonów faktycznie użyta dla danego locale (rejestr → adapter). */
  templateMapFor(locale: Locale): Record<string, number> {
    return (this.options.templateMapFor ?? buildBrevoTemplateMap)(locale);
  }

  private adapterFor(locale: Locale): BrevoAdapter {
    const cached = this.adapters.get(locale);
    if (cached) {
      return cached;
    }

    const adapter = new BrevoAdapter(this.client, {
      senders: this.options.senders,
      templates: this.templateMapFor(locale),
      clock: this.options.clock,
      uuid: this.options.uuid,
    });
    this.adapters.set(locale, adapter);
    return adapter;
  }
}
