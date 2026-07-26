/**
 * posthog.ts — rejestracja nośnika metryk jobów w kontenerze (Story 2.5,
 * R-2.5-H2).
 *
 * Joby czytają klienta PostHoga przez `container.resolve("posthog")`. Bez tego
 * loadera klucz nie istniał w ŻADNYM środowisku, więc wszystkie
 * `posthog?.capture(...)` były ciche — łącznie z metryką luki dostarczeń, na
 * której stoi alert AC3.
 *
 * Loader jest fail-open wobec bootu: brak `POSTHOG_API_KEY` rejestruje `null`
 * (jeden `warn` z klienta, patrz `posthog-metrics-client`), a nie wyjątek.
 * Backend musi startować bez telemetrii — ale nie po cichu.
 */

import type { MedusaContainer } from "@medusajs/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { asValue } from "awilix"

import {
  getPosthogCaptureClient,
  POSTHOG_CONTAINER_KEY,
} from "../lib/instrumentation/posthog-metrics-client"

type LoggerLike = { warn?: (message: string, meta?: unknown) => void }

export default async function posthogLoader({
  container,
}: {
  container: MedusaContainer
}): Promise<void> {
  let logger: LoggerLike | undefined
  try {
    logger = container.resolve(ContainerRegistrationKeys.LOGGER) as LoggerLike
  } catch {
    logger = undefined
  }

  const client = getPosthogCaptureClient(
    typeof logger?.warn === "function"
      ? (message, meta) => logger?.warn?.(message, meta)
      : undefined,
  )

  container.register({
    [POSTHOG_CONTAINER_KEY]: asValue(client),
  })
}
