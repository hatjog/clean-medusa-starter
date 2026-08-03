/**
 * Rejestr szablonów jako allowlista (Story 2.2, AC2 / AD-6).
 *
 * Testy pilnują trzech rzeczy:
 *  1. Projekcja TS jest wygenerowana z YAML-a bajt-w-bajt (jedno źródło prawdy;
 *     ręczna edycja pliku `.generated.ts` = FAIL).
 *  2. `buildBrevoTemplateMap` nie przemyca kluczy spoza rejestru i nie zamienia
 *     `not_configured` w jakiekolwiek ID.
 *  3. Klucz spoza rejestru NIE ma szansy trafić do mapy (allowlist).
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  GENERATED_FILE_SUBPATH,
  REGISTRY_YAML_SUBPATH,
  constantIdentifierFor,
  readRegistryEntries,
  renderGeneratedRegistry,
} from "../notification-template-registry-codegen";
import {
  BREVO_TEMPLATE_NOT_CONFIGURED,
  NOTIFICATION_TEMPLATE_KEYS,
  NOTIFICATION_TEMPLATE_REGISTRY,
  buildBrevoTemplateMap,
  isRegisteredTemplateKey,
  toRegistryLocale,
} from "../notification-template-registry";

const PACKAGE_ROOT = path.resolve(__dirname, "..", "..");
// packages/messaging → packages → GP/backend → GP → <repo root>
const REPO_ROOT = path.resolve(PACKAGE_ROOT, "..", "..", "..", "..");
const YAML_PATH = path.join(REPO_ROOT, REGISTRY_YAML_SUBPATH);

describe("projekcja rejestru YAML → TS", () => {
  it("plik .generated.ts jest identyczny z regeneracją z YAML-a (zero driftu)", () => {
    const onDisk = readFileSync(path.join(PACKAGE_ROOT, GENERATED_FILE_SUBPATH), "utf8");
    expect(renderGeneratedRegistry(YAML_PATH)).toBe(onDisk);
  });

  it("każdy wpis YAML ma stałą w NOTIFICATION_TEMPLATE_KEYS i odwrotnie", () => {
    const yamlKeys = readRegistryEntries(YAML_PATH).map((entry) => entry.template_key);
    expect(Object.values(NOTIFICATION_TEMPLATE_KEYS).sort()).toEqual([...yamlKeys].sort());

    for (const key of yamlKeys) {
      const ident = constantIdentifierFor(key);
      expect(
        (NOTIFICATION_TEMPLATE_KEYS as Record<string, string>)[ident],
      ).toBe(key);
    }
  });

  it("fail-loud gdy rejestru nie ma (brak kontekstu monorepo) — nie cichy fallback", () => {
    expect(() => readRegistryEntries(path.join(REPO_ROOT, "nie-ma-takiego-rejestru.yaml"))).toThrow(
      /nie można odczytać rejestru/,
    );
  });
});

describe("buildBrevoTemplateMap (AD-6 allowlist)", () => {
  it("nie zawiera kluczy z brevo: not_configured", () => {
    const notConfigured = NOTIFICATION_TEMPLATE_REGISTRY.filter(
      (entry) => entry.brevo[toRegistryLocale("pl-PL")] === BREVO_TEMPLATE_NOT_CONFIGURED,
    ).map((entry) => entry.template_key);

    const map = buildBrevoTemplateMap("pl-PL");
    for (const key of notConfigured) {
      expect(map[key]).toBeUndefined();
    }
  });

  it("mapa dla każdego locale zawiera DOKŁADNIE skonfigurowane wpisy rejestru", () => {
    // R-2.2-L6: wcześniej ten test asertował `toEqual({})` — czyli zapalał się na
    // czerwono w chwili, gdy operator (PO) uzupełni PIERWSZE ID szablonu Brevo,
    // czyli wykona dokładnie tę czynność, na którą story czeka. Pułapka na
    // legalną operację nie jest sygnałem, tylko szumem. Testujemy INWARIANT:
    // mapa == wpisy rejestru z ID ≠ `not_configured`, dla każdego locale.
    for (const locale of ["pl-PL", "uk-UA", "de-DE", "en-US"] as const) {
      const registryLocale = toRegistryLocale(locale);
      const expected = Object.fromEntries(
        NOTIFICATION_TEMPLATE_REGISTRY.filter(
          (entry) => entry.brevo[registryLocale] !== BREVO_TEMPLATE_NOT_CONFIGURED,
        ).map((entry) => [
          entry.template_key,
          Number(entry.brevo[registryLocale]),
        ]),
      );
      expect(buildBrevoTemplateMap(locale)).toEqual(expected);
    }
  });

  it("mapa nigdy nie zawiera klucza spoza rejestru", () => {
    const map = buildBrevoTemplateMap("pl-PL");
    for (const key of Object.keys(map)) {
      expect(isRegisteredTemplateKey(key)).toBe(true);
    }
    expect(isRegisteredTemplateKey("nieistniejacy_szablon")).toBe(false);
  });
});
