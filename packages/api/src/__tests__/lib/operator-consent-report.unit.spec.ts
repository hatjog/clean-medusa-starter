import { describe, it, expect, beforeEach } from "@jest/globals"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import { buildOperatorConsentReport } from "../../../src/lib/operator-consent-report"

type AnyFn = (...args: unknown[]) => unknown

function makeScope() {
  const sellers = [
    {
      id: "seller_1",
      handle: "studio-nova",
      email: "nova@example.com",
      metadata: {
        gp: {
          lifecycle_decision: {
            decision: "opted_in",
            captured_at: "2026-05-03T09:00:00Z",
          },
        },
      },
    },
    {
      id: "seller_2",
      handle: "city-beauty",
      email: "city@example.com",
      metadata: { gp: {} },
    },
  ]

  const logRows = [
    {
      id: "log_1",
      vendor_id: "seller_1",
      vendor_handle: "studio-nova",
      notification_type: "nudge_t21",
      sent_at: "2026-05-04T09:00:00Z",
      locale: "pl",
      recipient_email: "nova@example.com",
      status: "sent",
      triggered_by: "admin_1",
    },
    {
      id: "log_2",
      vendor_id: "seller_1",
      vendor_handle: "studio-nova",
      notification_type: "nudge_t14",
      sent_at: "2026-05-05T09:00:00Z",
      locale: "pl",
      recipient_email: "nova@example.com",
      status: "sent",
      triggered_by: "admin_1",
    },
  ]

  const kickoffRow = {
    id: "kickoff_1",
    started_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    t0_target: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString(),
    triggered_by: "admin_1",
    vendor_count: 2,
    admin_note: null,
    override: false,
    created_at: new Date().toISOString(),
  }

  const knex: AnyFn = jest.fn((table: string) => {
    if (table === "vendor_notification_log") {
      return {
        select: jest.fn(() => ({
          orderBy: jest.fn(() => Promise.resolve(logRows)),
        })),
      }
    }

    if (table === "operator_t30_kickoff") {
      return {
        select: jest.fn(() => ({
          orderBy: jest.fn(() => ({
            first: jest.fn().mockResolvedValue(kickoffRow),
          })),
        })),
      }
    }

    throw new Error(`Unexpected table ${table}`)
  })

  const sellerModuleService = {
    list: jest.fn().mockResolvedValue(sellers),
  }

  return {
    resolve: (key: string) => {
      if (key === ContainerRegistrationKeys.PG_CONNECTION) return knex
      if (key === "sellerModuleService") return sellerModuleService
      return undefined
    },
  }
}

describe("operator-consent-report", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("builds live vendor consent rows from seller metadata and notification log", async () => {
    const report = await buildOperatorConsentReport(makeScope(), {
      sort: "nudges_sent:desc",
    })

    expect(report.summary).toEqual({
      opted_in: 1,
      opted_out: 0,
      no_decision: 1,
      total: 2,
    })
    expect(report.vendors[0]).toMatchObject({
      id: "seller_1",
      decision_status: "opted_in",
      nudges_sent: 2,
      last_action: "nudge_t14",
    })
    expect(report.vendors[1]).toMatchObject({
      id: "seller_2",
      decision_status: "no_decision",
      nudges_sent: 0,
    })
    expect(report.window?.started_at).toBeTruthy()
  })
})