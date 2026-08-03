/**
 * generate-notification-template-registry.ts — projekcja rejestru szablonów
 * notyfikacji (YAML SSOT) na moduł TS ze stałymi.
 *
 * Story 2.2 (v1.14.0, AD-6). JEDNO źródło prawdy listy szablonów:
 * `specs/contracts/notifications/templates.yaml` (Story 2.1, ADR-158).
 * Ten skrypt NIE autoruje żadnego klucza — wyłącznie przepisuje rejestr do
 * postaci, którą TypeScript umie sprawdzić w compile-time. Ręczna edycja
 * pliku wyjściowego jest błędem (drift-test `notification-template-registry.test.ts`
 * regeneruje i porównuje bajt-w-bajt).
 *
 * Uruchomienie (z GP/backend):
 *   pnpm --filter @gp/messaging gen:notification-templates
 *
 * Wymaga kontekstu monorepo GP (rejestr żyje w super-repo, nie w submodule) —
 * fail-loud gdy rejestru nie ma, bez cichego fallbacku na pustą listę.
 */

import { writeFileSync } from "node:fs";
import path from "node:path";

import {
  GENERATED_FILE_SUBPATH,
  REGISTRY_YAML_SUBPATH,
  renderGeneratedRegistry,
} from "../src/notification-template-registry-codegen";

const packageRoot = path.resolve(__dirname, "..");
// scripts/ → messaging → packages → GP/backend → GP → <repo root>
const repoRoot = path.resolve(__dirname, "..", "..", "..", "..", "..");

function main(): void {
  const yamlPath = path.join(repoRoot, REGISTRY_YAML_SUBPATH);
  const outPath = path.join(packageRoot, GENERATED_FILE_SUBPATH);

  const rendered = renderGeneratedRegistry(yamlPath);
  writeFileSync(outPath, rendered, "utf8");

  // eslint-disable-next-line no-console
  console.info(
    `[gen:notification-templates] ${REGISTRY_YAML_SUBPATH} → packages/messaging/${GENERATED_FILE_SUBPATH}`,
  );
}

main();
