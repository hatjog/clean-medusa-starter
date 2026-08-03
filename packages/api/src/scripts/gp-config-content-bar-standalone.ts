/**
 * Standalone entrypoint pomiaru baru treści (AD-4) — BEZ `medusa exec`.
 *
 * Code review 4.3 F2: wywołanie przez `pnpm gp-config-content-bar` bootuje
 * cały kontener Medusy (w tym realne połączenie do Postgresa — `SELECT 1`
 * w pg-connection-loader), mimo że sam pomiar czyta wyłącznie source YAML.
 * Konsumenci deklarujący "read-only, bez DB/Medusy" (raport FR-23 w
 * gp-ops/cli, etapy no-LLM pipeline'u FR-22) MUSZĄ wołać ten entrypoint:
 *
 *   pnpm gp-config-content-bar:standalone --market bonbeauty --instance gp-dev
 *
 * Kontrakt stdout jest IDENTYCZNY jak w wariancie `medusa exec` (ten sam
 * `gpConfigContentBar`); różni się wyłącznie brakiem bootu appki. Błąd →
 * komunikat na stderr + exit 1, stdout pozostaje czysty (tylko JSON payload).
 */

import gpConfigContentBar from "./gp-config-content-bar"

gpConfigContentBar({ args: process.argv.slice(2) }).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
