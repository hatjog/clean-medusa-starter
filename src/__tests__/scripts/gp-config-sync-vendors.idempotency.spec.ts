/**
 * Idempotency tests for gp-config-sync-vendors.ts — upsertSeller()
 *
 * Story 7.8 — AC: #1, #2, #4
 *
 * Verifies that calling upsertSeller() 3× for the same vendor produces
 * identical DB state on each run (no drift, no duplicate field tracking).
 * Uses in-memory mock sellerService — no real DB required.
 * Pattern follows sync-vendors-ownership.test.ts (story 7.7).
 */

import { upsertSeller } from '../../scripts/gp-config-sync-vendors'

// ---- In-memory store ----

let inMemorySellers: Map<string, any>

// ---- Mock factory ----

function makeSellerService() {
  return {
    list: jest.fn(async ({ handle }: { handle: string }) => {
      const seller = inMemorySellers.get(handle)
      return seller ? [seller] : []
    }),
    create: jest.fn(async (payload: any) => {
      const id = `seller-${payload.handle}`
      const seller = { id, ...payload }
      inMemorySellers.set(payload.handle, seller)
      return seller
    }),
    update: jest.fn(async (id: string, payload: any) => {
      for (const [handle, seller] of inMemorySellers.entries()) {
        if (seller.id === id) {
          // Simulate Medusa's deep metadata merge: top-level fields overwrite,
          // metadata object is replaced by the payload's metadata (as in the real script)
          const updated = { ...seller, ...payload }
          inMemorySellers.set(handle, updated)
          return updated
        }
      }
    }),
  }
}

// ---- Snapshot helper ----

function snapshotSellers() {
  return JSON.parse(
    JSON.stringify(
      Array.from(inMemorySellers.values()).sort((a, b) =>
        (a.handle ?? '').localeCompare(b.handle ?? '')
      )
    )
  )
}

// ---- Test fixture ----

const TEST_VENDOR = {
  vendor_id: 'kremidotyk',
  slug: 'kremidotyk',
  status: 'onboarded',
  display_name: 'KREM i DOTYK',
  email: 'kontakt@kremidotyk.pl',
  phone: '+48578919155',
  description: 'Masaże ciała i zabiegów pielęgnacyjnych',
  photo_url: 'https://cdn.example.com/kremidotyk/photo.jpg',
  gallery_urls: ['https://cdn.example.com/kremidotyk/g1.jpg'],
}

// ---- Setup ----

beforeEach(() => {
  inMemorySellers = new Map()
})

// ---- Tests ----

describe('upsertSeller — idempotency: 3× runs produce identical DB state (AC #1, #2, #4)', () => {
  it('snapshots after run1, run2, run3 are deep-equal (no state drift)', async () => {
    const sellerService = makeSellerService()

    // Run 1: creates the seller (fresh vendor)
    const result1 = await upsertSeller(sellerService, TEST_VENDOR, false, 'bonbeauty')
    expect(result1.action).toBe('created')
    const snap1 = snapshotSellers()

    // Run 2: updates the seller (vendor already exists)
    const result2 = await upsertSeller(sellerService, TEST_VENDOR, false, 'bonbeauty')
    expect(result2.action).toBe('updated')
    const snap2 = snapshotSellers()

    // Run 3: updates the seller again
    const result3 = await upsertSeller(sellerService, TEST_VENDOR, false, 'bonbeauty')
    expect(result3.action).toBe('updated')
    const snap3 = snapshotSellers()

    expect(snap2).toEqual(snap1)
    expect(snap3).toEqual(snap1)
  })

  it('sellerService.create() called exactly once (no duplicate creates)', async () => {
    const sellerService = makeSellerService()

    for (let run = 0; run < 3; run++) {
      await upsertSeller(sellerService, TEST_VENDOR, false, 'bonbeauty')
    }

    expect(sellerService.create).toHaveBeenCalledTimes(1)
    expect(sellerService.update).toHaveBeenCalledTimes(2)
  })

  it('seeded_fields list does NOT grow across runs (no redundant tracking, AC #4)', async () => {
    const sellerService = makeSellerService()

    // Run 1: seed
    await upsertSeller(sellerService, TEST_VENDOR, false, 'bonbeauty')
    const seededAfterRun1: string[] =
      inMemorySellers.get('kremidotyk')?.metadata?.gp?.seeded_fields ?? []

    // Run 2: update
    await upsertSeller(sellerService, TEST_VENDOR, false, 'bonbeauty')
    const seededAfterRun2: string[] =
      inMemorySellers.get('kremidotyk')?.metadata?.gp?.seeded_fields ?? []

    // Run 3: update
    await upsertSeller(sellerService, TEST_VENDOR, false, 'bonbeauty')
    const seededAfterRun3: string[] =
      inMemorySellers.get('kremidotyk')?.metadata?.gp?.seeded_fields ?? []

    // seeded_fields must be stable (no expansion on re-runs)
    expect(seededAfterRun2).toEqual(seededAfterRun1)
    expect(seededAfterRun3).toEqual(seededAfterRun1)

    // All seed_if_empty fields tracked from run 1
    expect(seededAfterRun1).toContain('name')
    expect(seededAfterRun1).toContain('description')
    expect(seededAfterRun1).toContain('photo_url')
    expect(seededAfterRun1).toContain('gallery')
  })

  it('config_wins fields (email, phone, store_status) are consistently updated on every run', async () => {
    const sellerService = makeSellerService()

    await upsertSeller(sellerService, TEST_VENDOR, false, 'bonbeauty')

    // Run 2 update payload must always include config_wins fields
    await upsertSeller(sellerService, TEST_VENDOR, false, 'bonbeauty')
    const run2UpdatePayload = sellerService.update.mock.calls[0][1]

    expect(run2UpdatePayload.email).toBe(TEST_VENDOR.email)
    expect(run2UpdatePayload.phone).toBe(TEST_VENDOR.phone)
    expect(run2UpdatePayload.store_status).toBe('ACTIVE')

    // Run 3 update payload identical to run 2
    await upsertSeller(sellerService, TEST_VENDOR, false, 'bonbeauty')
    const run3UpdatePayload = sellerService.update.mock.calls[1][1]

    expect(run3UpdatePayload.email).toBe(run2UpdatePayload.email)
    expect(run3UpdatePayload.phone).toBe(run2UpdatePayload.phone)
    expect(run3UpdatePayload.store_status).toBe(run2UpdatePayload.store_status)
  })
})

describe('upsertSeller — idempotency with multiple vendors', () => {
  it('multiple vendors: all 3 runs produce identical snapshots', async () => {
    const sellerService = makeSellerService()

    const vendors = [
      { ...TEST_VENDOR, vendor_id: 'kremidotyk', slug: 'kremidotyk' },
      {
        vendor_id: 'citybeauty',
        slug: 'citybeauty',
        status: 'active',
        display_name: 'City Beauty',
        email: 'info@citybeauty.pl',
        description: 'Salon kosmetyczny w centrum',
      },
    ]

    // Run 1
    for (const vendor of vendors) {
      await upsertSeller(sellerService, vendor, false, 'bonbeauty')
    }
    const snap1 = snapshotSellers()

    // Run 2
    for (const vendor of vendors) {
      await upsertSeller(sellerService, vendor, false, 'bonbeauty')
    }
    const snap2 = snapshotSellers()

    // Run 3
    for (const vendor of vendors) {
      await upsertSeller(sellerService, vendor, false, 'bonbeauty')
    }
    const snap3 = snapshotSellers()

    expect(snap2).toEqual(snap1)
    expect(snap3).toEqual(snap1)
    expect(inMemorySellers.size).toBe(2)
  })
})
