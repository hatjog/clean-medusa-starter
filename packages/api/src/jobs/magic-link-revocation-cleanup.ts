import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { Knex } from "knex"

import { PostgresMagicLinkStore } from "../lib/auth/magic-link-revocation"

export const SCHEDULE_NAME = "magic-link-revocation-cleanup" as const
export const SCHEDULE_CRON = "15 3 * * *" as const

type JobLogger = {
  info: (message: string) => void
  warn: (message: string) => void
  error: (message: string, err?: unknown) => void
}

function resolveLogger(container: MedusaContainer | undefined): JobLogger {
  const fallback: JobLogger = {
    info: (message) => console.log(`[${SCHEDULE_NAME}] ${message}`),
    warn: (message) => console.warn(`[${SCHEDULE_NAME}] ${message}`),
    error: (message, err) => console.error(`[${SCHEDULE_NAME}] ${message}`, err),
  }

  try {
    const resolved = container?.resolve?.("logger") as Partial<JobLogger> | undefined
    if (resolved?.info) {
      return {
        info: resolved.info.bind(resolved),
        warn: (resolved.warn ?? resolved.info).bind(resolved),
        error: (resolved.error ?? resolved.info).bind(resolved),
      }
    }
  } catch {
    return fallback
  }

  return fallback
}

function resolveDb(container: MedusaContainer | undefined): Knex | null {
  try {
    return container?.resolve?.(ContainerRegistrationKeys.PG_CONNECTION) as Knex
  } catch {
    return null
  }
}

export default async function magicLinkRevocationCleanup(
  container: MedusaContainer
): Promise<void> {
  const logger = resolveLogger(container)
  const db = resolveDb(container)

  if (!db) {
    logger.warn("pg connection unavailable; skipping cleanup")
    return
  }

  const store = new PostgresMagicLinkStore(db)
  const deleted = await store.cleanupExpiredRevocations()
  logger.info(`deleted=${deleted}`)
}

export const config = {
  name: SCHEDULE_NAME,
  schedule: SCHEDULE_CRON,
}
