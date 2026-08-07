/**
 * v1.15.0 Story 4.1, runda fixów — WPIĘCIE bariery w kontener modułu
 * Notification jest ZMIERZONE, a nie założone (R-4.1-M1).
 *
 * ── Dlaczego ta suita istnieje ─────────────────────────────────────────────
 * Cała produkcyjna ścieżka bariery stała na jednym ZAŁOŻENIU zapisanym
 * w komentarzu: że kontener modułu Notification widzi `PG_CONNECTION`, bo
 * loader Medusy dopisuje ten klucz do zależności KAŻDEGO modułu. Założenie było
 * osłabione trzema rzeczami: brak precedensu w repo (wszystkie pozostałe
 * odczyty `PG_CONNECTION` idą z `req.scope` albo z kontenera joba), brak
 * jakiegokolwiek artefaktu z wykonania oraz koszt pomyłki — `resolveBarrier()`
 * oddaje wtedy barierę ODMAWIAJĄCĄ, czyli ZERO maili na ścieżce, która działa.
 *
 * Czego ta suita NIE robi: nie bootuje backendu. Mierzy natomiast REALNIE
 * ZAINSTALOWANY pakiet Medusy — ten sam, z którego zbuduje się produkcja — więc
 * upgrade, który zmieni tę rejestrację, PĘKA tutaj, zamiast objawić się zerową
 * wysyłką. Miejsce pomiaru pełnego (boot + realny kontener) jest nazwane
 * w sekcji „Ograniczenia" story.
 */
import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"

import { describe, it, expect } from "@jest/globals"

const require_ = createRequire(__filename)

describe("R-4.1-M1 — `PG_CONNECTION` w kontenerze modułu: ZMIERZONE na zainstalowanej Medusie", () => {
  it("loader modułów REJESTRUJE `PG_CONNECTION` w kontenerze każdego modułu", () => {
    // To jest dokładnie to ogniwo, na którym stoi cała ścieżka: bez tej linii
    // provider Brevo dostaje `undefined` i KAŻDA wysyłka odmawia.
    const loaderPath = require_.resolve(
      "@medusajs/modules-sdk/dist/loaders/utils/load-internal.js",
    )
    expect(existsSync(loaderPath)).toBe(true)

    const source = readFileSync(loaderPath, "utf8")
    const registration = source
      .split("\n")
      .find((line) => line.includes("dependencies.push("))

    expect(registration).toBeDefined()
    expect(registration).toContain("ContainerRegistrationKeys.PG_CONNECTION")
  })

  it("rejestracja jest BEZWARUNKOWA — nie zależy od opcji modułu", () => {
    // Gdyby była warunkowa, „loader to dopisuje" przestałoby być gwarancją
    // dla NASZEGO modułu, a werdykt zależałby od konfiguracji, której nikt
    // nie sprawdza.
    const source = readFileSync(
      require_.resolve("@medusajs/modules-sdk/dist/loaders/utils/load-internal.js"),
      "utf8",
    )
    const lines = source.split("\n")
    const idx = lines.findIndex((line) => line.includes("dependencies.push("))
    expect(idx).toBeGreaterThan(-1)

    // Linia bezpośrednio poprzedzająca to pobranie listy zależności resolucji,
    // a nie otwarcie gałęzi warunkowej.
    expect(lines[idx - 1]).toContain("resolution?.dependencies")
    expect(lines[idx].trimStart().startsWith("dependencies.push(")).toBe(true)
  })

  it("wersja Medusy, na której pomiar wykonano, jest ZAPISANA (upgrade wymaga ponownego pomiaru)", () => {
    const version = require_("@medusajs/modules-sdk/package.json").version as string
    // Nie przypinamy wersji na sztywno (to byłaby bramka na upgrade), ale
    // zapisujemy, że pomiar dotyczy linii 2.x — poza nią kształt loadera nie
    // był mierzony przez tę story.
    expect(version.startsWith("2.")).toBe(true)
  })

  it("provider czyta klucz TYM SAMYM identyfikatorem, którym loader go rejestruje", () => {
    // Rozjazd nazwy klucza byłby niewidoczny w typach (indeks stringowy),
    // a objawiłby się dopiero zerową wysyłką na produkcji.
    const service = readFileSync(
      path.join(__dirname, "../../modules/notification-brevo/service.ts"),
      "utf8",
    )
    expect(service).toContain("ContainerRegistrationKeys.PG_CONNECTION")
  })
})
