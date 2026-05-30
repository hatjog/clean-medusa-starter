import {
  GoogleWalletApiClient,
  GoogleWalletApiError,
  statusOf,
  type GoogleWalletApiSurface,
} from "../google-api-client"
import type { GoogleWalletProviderConfig } from "../google-config"

const config: GoogleWalletProviderConfig = {
  issuer_id: "3388000000022223333",
  service_account_email: "wallet-demo@example.iam.gserviceaccount.com",
  private_key: "fake-key",
  class_id_template: "{issuer_id}.bonbeauty_voucher_v1",
  origin_save_base: "https://pay.google.com/gp/v/save/",
  request_timeout_ms: 2_000,
}

function createWalletObjects(
  insert: jest.Mock = jest.fn(async () => undefined),
  patch: jest.Mock = jest.fn(async () => undefined)
): GoogleWalletApiSurface {
  return {
    offerclass: { insert },
    offerobject: { patch },
  }
}

describe("GoogleWalletApiClient", () => {
  it("traktuje HTTP 409 przy OfferClass insert jako idempotentny sukces", async () => {
    const insert = jest.fn(async () => {
      throw { response: { status: 409 } }
    })
    const walletobjects = createWalletObjects(insert)
    const client = new GoogleWalletApiClient(config, { walletobjects })

    await expect(
      client.upsertOfferClass({ id: "3388000000022223333.bonbeauty_voucher_v1" })
    ).resolves.toBeUndefined()
    expect(insert).toHaveBeenCalledTimes(1)
  })

  it("cacheuje class id po udanym upsert, zeby nie powtarzac goracej sciezki", async () => {
    const insert = jest.fn(async () => undefined)
    const walletobjects = createWalletObjects(insert)
    const client = new GoogleWalletApiClient(config, { walletobjects })

    await client.upsertOfferClass({
      id: "3388000000022223333.bonbeauty_voucher_v1",
    })
    await client.upsertOfferClass({
      id: "3388000000022223333.bonbeauty_voucher_v1",
    })

    expect(insert).toHaveBeenCalledTimes(1)
  })

  it("retryuje 5xx raz i zwraca typed API error po drugim niepowodzeniu", async () => {
    const insert = jest
      .fn()
      .mockRejectedValueOnce({ response: { status: 500 } })
      .mockRejectedValueOnce({ response: { status: 503 } })
    const delay = jest.fn(async () => undefined)
    const client = new GoogleWalletApiClient(config, {
      walletobjects: createWalletObjects(insert),
      delay,
    })

    await expect(
      client.upsertOfferClass({ id: "3388000000022223333.bonbeauty_voucher_v1" })
    ).rejects.toMatchObject({
      name: "GoogleWalletApiError",
      error_code: "GOOGLE_WALLET_API_ERROR",
      status: 503,
    } satisfies Partial<GoogleWalletApiError>)
    expect(insert).toHaveBeenCalledTimes(2)
    expect(delay).toHaveBeenCalledWith(250)
  })

  it("klasyfikuje HTTP 429 jako rate limit po retry", async () => {
    const insert = jest
      .fn()
      .mockRejectedValueOnce({ response: { status: 429 } })
      .mockRejectedValueOnce({ response: { status: 429 } })
    const client = new GoogleWalletApiClient(config, {
      walletobjects: createWalletObjects(insert),
      delay: jest.fn(async () => undefined),
    })

    await expect(
      client.upsertOfferClass({ id: "3388000000022223333.bonbeauty_voucher_v1" })
    ).rejects.toMatchObject({
      name: "GoogleWalletApiError",
      error_code: "GOOGLE_WALLET_RATE_LIMITED",
      status: 429,
    } satisfies Partial<GoogleWalletApiError>)
  })

  it("traktuje HTTP 404 przy invalidate patch jako juz nieistniejacy obiekt", async () => {
    const patch = jest.fn(async () => {
      throw { response: { status: 404 } }
    })
    const client = new GoogleWalletApiClient(config, {
      walletobjects: createWalletObjects(undefined, patch),
    })

    await expect(
      client.patchOfferObject("3388000000022223333.bonbeauty_voucher_v1.ei_123", {
        state: "INACTIVE",
      })
    ).resolves.toBeUndefined()
  })

  it("przekazuje timeout 2000 ms do googleapis request options", async () => {
    const insert = jest.fn(async () => undefined)
    const client = new GoogleWalletApiClient(config, {
      walletobjects: createWalletObjects(insert),
    })

    await client.upsertOfferClass({
      id: "3388000000022223333.bonbeauty_voucher_v1",
    })

    const firstCall = insert.mock.calls[0] as unknown[] | undefined
    expect(firstCall?.[1]).toMatchObject({ timeout: 2_000 })
  })

  it("odczytuje status z najczestszych ksztaltow bledow HTTP", () => {
    expect(statusOf({ response: { status: 409 } })).toBe(409)
    expect(statusOf({ status: 500 })).toBe(500)
    expect(statusOf({ code: 429 })).toBe(429)
    expect(statusOf(new Error("boom"))).toBeUndefined()
  })
})
