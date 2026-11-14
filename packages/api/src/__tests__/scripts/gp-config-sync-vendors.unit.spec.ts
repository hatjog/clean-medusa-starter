import { resolveProductByFixture, upsertSeller } from '../../scripts/gp-config-sync-vendors'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import gpConfigSyncVendors, {
  vendorStatusToSellerStatus,
  VENDOR_STATUS_UNRECOGNIZED,
} from '../../scripts/gp-config-sync-vendors'

describe('upsertSeller dry-run', () => {
  it('reports normalized seed_if_empty diffs without updating the DB', async () => {
    const sellerModuleService = {
      list: jest.fn().mockResolvedValue([
        {
          id: 'seller-1',
          handle: 'city-beauty',
          name: 'City Beauty',
          // Review cykl 4: wartość kanoniczna mieszka w KOLUMNIE encji;
          // `metadata.gp.*` to rejestr pochodzenia seeda. Nota dry-run opisuje
          // stan kolumn, bo to je zobaczy storefront.
          description: 'A &amp; B',
          logo: 'https://cdn.example.com/old.jpg',
          metadata: {
            gp: {
              seeded_fields: ['description', 'photo_url'],
              description: 'A &amp; B',
              photo_url: 'https://cdn.example.com/old.jpg',
            },
          },
        },
      ]),
      update: jest.fn(),
    }

    const result = await upsertSeller(
      sellerModuleService,
      {
        vendor_id: 'city-beauty',
        slug: 'city-beauty',
        // Story 7.9: zamknięty katalog statusów — brak pola to odmowa, nie `open`.
        status: 'onboarded',
        description: 'A & B',
        photo_url: 'https://cdn.example.com/new.jpg',
      },
      true,
      'bonbeauty'
    )

    expect(result.action).toBe('updated')
    expect(result.note).toContain('photo_url: https://cdn.example.com/old.jpg -> https://cdn.example.com/new.jpg')
    expect(result.note).not.toContain('description:')
    expect(sellerModuleService.update).not.toHaveBeenCalled()
  })

  // Verify-B5 V5: ten test kodował kontrakt SPRZED ADR-165 („--overwrite wymusza
  // zapis config-owned"). Po odwróceniu semantyki przechodził wakacyjnie —
  // asertował wyłącznie notę diffu, która w dry-runie powstaje niezależnie od
  // decyzji o zapisie. Przepisany na kontrakt PO ADR-165: pole edytowane przez
  // vendora jest POMIJANE mimo `--overwrite`, a pominięcie jest raportowane.
  it('dry-run z overwrite=true raportuje pole vendor-owned jako pominięte (ADR-165), a nie jako nadpisane', async () => {
    const sellerModuleService = {
      list: jest.fn().mockResolvedValue([
        {
          id: 'seller-1',
          handle: 'city-beauty',
          name: 'City Beauty',
          // Kolumna (wartość) rozjechana z rejestrem (co zasialiśmy) ⇒ Case 2:
          // vendor edytował pole po zasianiu.
          description: 'Vendor custom description',
          metadata: {
            gp: {
              market_id: 'bonbeauty',
              seeded_fields: ['description'],
              description: 'Seeded description',
            },
          },
        },
      ]),
      update: jest.fn(),
    }

    const result = await upsertSeller(
      sellerModuleService,
      {
        vendor_id: 'city-beauty',
        slug: 'city-beauty',
        // Story 7.9: zamknięty katalog statusów — brak pola to odmowa, nie `open`.
        status: 'onboarded',
        description: 'Canonical config description',
      },
      true,
      'bonbeauty',
      'pln',
      true
    )

    expect(result.action).toBe('updated')
    // pole jest seeded, ale DB != config → vendor je edytował (Case 2)
    expect(result.ownershipProtectedFields).toEqual(['description'])
    expect(result.note).toContain('vendor-owned (pominięte mimo --overwrite, ADR-165)')
    expect(result.note).toContain('description')
    expect(sellerModuleService.update).not.toHaveBeenCalled()
  })

  it('skips seller update when the existing handle belongs to another market', async () => {
    const sellerModuleService = {
      list: jest.fn().mockResolvedValue([
        {
          id: 'seller-foreign',
          handle: 'city-beauty',
          metadata: {
            gp: {
              market_id: 'mercur',
            },
          },
        },
      ]),
      update: jest.fn(),
    }

    const result = await upsertSeller(
      sellerModuleService,
      {
        vendor_id: 'city-beauty',
        slug: 'city-beauty',
        // Story 7.9: zamknięty katalog statusów — brak pola to odmowa, nie `open`.
        status: 'onboarded',
        description: 'Canonical config description',
      },
      true,
      'bonbeauty',
      'pln',
      true
    )

    expect(result.action).toBe('skipped')
    expect(result.note).toContain("cross-market guard")
    expect(sellerModuleService.update).not.toHaveBeenCalled()
  })
})

describe('resolveProductByFixture', () => {
  it('returns fixture strategy when fixture lookup finds product', async () => {
    const listProducts = jest.fn().mockResolvedValueOnce([{ id: 'prod_fixture_1' }])

    const result = await resolveProductByFixture(listProducts, 'srv_0206', 'masaz-banka-twarz')

    expect(result.product?.id).toBe('prod_fixture_1')
    expect(result.strategy).toBe('fixture')
    expect(listProducts).toHaveBeenCalledTimes(1)
  })

  it('falls back to handle strategy when fixture lookup returns empty', async () => {
    const listProducts = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'prod_handle_1' }])

    const result = await resolveProductByFixture(listProducts, 'srv_0208', 'masaz-twarz-maska-ampulka')

    expect(result.product?.id).toBe('prod_handle_1')
    expect(result.strategy).toBe('handle')
    expect(listProducts).toHaveBeenNthCalledWith(1, { metadata: { gp: { fixture_id: 'srv_0208' } } })
    expect(listProducts).toHaveBeenNthCalledWith(2, { handle: 'masaz-twarz-maska-ampulka' })
  })

  it('returns none when fixture lookup throws and fallback handle is missing', async () => {
    const listProducts = jest.fn().mockRejectedValueOnce(new Error('db offline'))

    const result = await resolveProductByFixture(listProducts, 'srv_0206')

    expect(result.product).toBeNull()
    expect(result.strategy).toBe('none')
    expect(result.error).toContain('fixture lookup failed')
  })
})

// ---- Story 7.9 — fail-closed katalog statusów sprzedawcy (DW-15-177) ----

const STORY_79_CATALOG = [
  'pending_approval',
  'pending',
  'open',
  'onboarded',
  'active',
  'suspended',
  'paused',
  'inactive',
  'terminated',
  'archived',
  'disabled',
]

function makeStory79SellerService() {
  const sellers = new Map<string, any>()
  return {
    sellers,
    list: jest.fn(async ({ handle }: { handle: string }) => {
      const seller = sellers.get(handle)
      return seller ? [seller] : []
    }),
    create: jest.fn(async (payload: any) => {
      const seller = { id: `seller-${payload.handle}`, ...payload }
      sellers.set(payload.handle, seller)
      return seller
    }),
    update: jest.fn(async (id: string, payload: any) => {
      for (const [handle, seller] of sellers.entries()) {
        if (seller.id === id) {
          const updated = { ...seller, ...payload }
          sellers.set(handle, updated)
          return updated
        }
      }
      return undefined
    }),
  }
}

function makeStory79Db() {
  const builder: any = {}
  for (const m of ['select', 'whereRaw', 'whereNull', 'where', 'distinct', 'innerJoin', 'insert', 'onConflict', 'merge', 'update']) {
    builder[m] = jest.fn(() => builder)
  }
  builder.first = jest.fn(async () => undefined)
  builder.then = (resolve: (v: unknown[]) => unknown) => resolve([])
  return jest.fn(() => builder)
}

function writeStory79MarketConfig(vendors: Array<Record<string, unknown>>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-7-9-'))
  const dir = path.join(root, 'gp_test', 'markets', 'bonbeauty')
  fs.mkdirSync(dir, { recursive: true })
  const lines = ['market_id: bonbeauty', 'currency: PLN', 'vendors:']
  for (const v of vendors) {
    lines.push(`  - vendor_id: ${v.vendor_id}`)
    lines.push(`    slug: ${v.slug}`)
    if (v.status !== undefined) lines.push(`    status: ${v.status}`)
  }
  fs.writeFileSync(path.join(dir, 'market.yaml'), lines.join('\n') + '\n')
  return root
}

async function runStory79Sync(configRoot: string, sellerService: any) {
  const container = {
    resolve: (key: string) => {
      if (key === 'seller') return sellerService
      if (key === 'product') return { listProducts: jest.fn(async () => []) }
      if (key === '__pg_connection__' || key === 'pg_connection') return makeStory79Db()
      throw new Error(`not registered: ${key}`)
    },
  }
  const prevRoot = process.env.GP_CONFIG_ROOT
  const prevExit = process.exitCode
  const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined)
  const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  process.env.GP_CONFIG_ROOT = configRoot
  try {
    return await gpConfigSyncVendors({ container, args: ['gp_test', 'bonbeauty'] } as any)
  } finally {
    if (prevRoot === undefined) delete process.env.GP_CONFIG_ROOT
    else process.env.GP_CONFIG_ROOT = prevRoot
    process.exitCode = prevExit
    logSpy.mockRestore()
    warnSpy.mockRestore()
  }
}

describe('Story 7.9 AC1 — odmowa per rekord, bez domyślnego open', () => {
  it('mapowanie: każda wartość spoza katalogu daje vendor_status_unrecognized, nigdy "open"', () => {
    for (const status of ['onboardd', 'ACTIVE', 'Open', '', ' active', 'enabled', 'approved', undefined]) {
      const result = vendorStatusToSellerStatus(status as string | undefined)
      expect(result).toEqual({ ok: false, reason: VENDOR_STATUS_UNRECOGNIZED })
      expect((result as any).status).not.toBe('open')
    }
  })

  it('mapowanie: katalog rozpoznanych wartości zachowuje dotychczasowe statusy Mercur', () => {
    const expected: Record<string, string> = {
      pending_approval: 'pending_approval',
      pending: 'pending_approval',
      open: 'open',
      onboarded: 'open',
      active: 'open',
      suspended: 'suspended',
      paused: 'suspended',
      inactive: 'suspended',
      terminated: 'terminated',
      archived: 'terminated',
      disabled: 'terminated',
    }
    for (const status of STORY_79_CATALOG) {
      expect(vendorStatusToSellerStatus(status)).toEqual({ ok: true, status: expected[status] })
    }
  })

  it('synchronizacja: rekord spoza katalogu pominięty z kodem i licznikiem, pozostałe przetworzone', async () => {
    const sellerService = makeStory79SellerService()
    const root = writeStory79MarketConfig([
      { vendor_id: 'typo-salon', slug: 'typo-salon', status: 'enabled' },
      { vendor_id: 'good-salon', slug: 'good-salon', status: 'onboarded' },
    ])

    const summary = await runStory79Sync(root, sellerService)

    expect(summary.vendor_status_rejections).toEqual([
      { vendor_id: 'typo-salon', status: 'enabled', reason: 'vendor_status_unrecognized' },
    ])
    expect(summary.vendors.rejected).toBe(1)
    expect(summary.ok).toBe(false)
    expect(summary.warnings.some((w) => w.includes("Vendor 'typo-salon': vendor_status_unrecognized"))).toBe(true)
    const createdHandles = sellerService.create.mock.calls.map((c: any[]) => c[0].handle)
    expect(createdHandles).toEqual(['good-salon'])
    expect(sellerService.list).not.toHaveBeenCalledWith({ handle: 'typo-salon' })
    expect(sellerService.update).not.toHaveBeenCalled()
    expect(summary.vendors.created).toBe(1)
  })

  it('synchronizacja: brak pola status też jest odmową (brak pola ≠ zgoda)', async () => {
    const sellerService = makeStory79SellerService()
    const root = writeStory79MarketConfig([{ vendor_id: 'no-status', slug: 'no-status' }])

    const summary = await runStory79Sync(root, sellerService)

    expect(summary.vendor_status_rejections).toEqual([
      { vendor_id: 'no-status', status: null, reason: 'vendor_status_unrecognized' },
    ])
    expect(summary.vendors.rejected).toBe(1)
    expect(sellerService.create).not.toHaveBeenCalled()
  })

  it('upsertSeller wywołany bezpośrednio z nierozpoznanym statusem nie tworzy sprzedawcy', async () => {
    const sellerService = makeStory79SellerService()
    const result = await upsertSeller(
      sellerService,
      { vendor_id: 'x', slug: 'x', status: 'onboardd' } as any,
      false,
      'bonbeauty'
    )
    expect(result).toEqual({ sellerId: null, action: 'skipped', note: 'vendor_status_unrecognized' })
    expect(sellerService.create).not.toHaveBeenCalled()
    expect(sellerService.update).not.toHaveBeenCalled()
  })
})

describe('Story 7.9 AC2 — para mutant onboardd / poprawka', () => {
  it('ten sam rekord: onboardd ⇒ brak sprzedawcy open; onboarded ⇒ sprzedawca open', async () => {
    const sellerService = makeStory79SellerService()

    // Przebieg 1 — mutant.
    const summary1 = await runStory79Sync(
      writeStory79MarketConfig([{ vendor_id: 'salon-79', slug: 'salon-79', status: 'onboardd' }]),
      sellerService
    )
    expect(summary1.vendor_status_rejections).toEqual([
      { vendor_id: 'salon-79', status: 'onboardd', reason: 'vendor_status_unrecognized' },
    ])
    expect(sellerService.create).not.toHaveBeenCalled()
    expect(sellerService.sellers.get('salon-79')).toBeUndefined()

    // Przebieg 2 — ten sam rekord po poprawieniu wartości.
    const summary2 = await runStory79Sync(
      writeStory79MarketConfig([{ vendor_id: 'salon-79', slug: 'salon-79', status: 'onboarded' }]),
      sellerService
    )
    expect(summary2.vendor_status_rejections).toEqual([])
    expect(summary2.vendors.rejected).toBe(0)
    expect(sellerService.create).toHaveBeenCalledTimes(1)
    expect(sellerService.create.mock.calls[0][0]).toMatchObject({ handle: 'salon-79', status: 'open' })
    expect(sellerService.sellers.get('salon-79')?.status).toBe('open')
  })
})
