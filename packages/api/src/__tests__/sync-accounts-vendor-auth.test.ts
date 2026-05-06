import {
  ensureVendorSellerAccess,
  resetAuthIdentityCacheForTests,
} from "../scripts/gp-config-sync-accounts"

describe("ensureVendorSellerAccess", () => {
  beforeEach(() => {
    resetAuthIdentityCacheForTests()
  })

  it("links vendor auth identity to member_id and creates seller membership when missing", async () => {
    const authIdentity = {
      id: "auth_1",
      app_metadata: {
        user_id: "user_1",
      },
      provider_identities: [
        {
          provider: "emailpass",
          entity_id: "admin@kremidotyk.pl",
        },
      ],
    }

    const authService = {
      listAuthIdentities: jest.fn().mockResolvedValue([authIdentity]),
      retrieveAuthIdentity: jest.fn().mockResolvedValue(authIdentity),
      updateAuthIdentities: jest.fn().mockResolvedValue(undefined),
      createAuthIdentities: jest.fn(),
    }

    const sellerService = {
      list: jest.fn().mockResolvedValue([
        {
          id: "seller_1",
          handle: "kremidotyk",
          metadata: { gp: { market_id: "bonbeauty" } },
        },
      ]),
      upsertMembers: jest.fn().mockResolvedValue([
        {
          id: "member_1",
          email: "admin@kremidotyk.pl",
        },
      ]),
      listSellerMembers: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]),
      createSellerMembers: jest.fn().mockResolvedValue([
        {
          id: "seller_member_1",
        },
      ]),
    }

    const warnings: string[] = []

    await ensureVendorSellerAccess(
      sellerService as any,
      authService as any,
      {
        email: "admin@kremidotyk.pl",
        password: "Secret123!",
        display_name: "Kremidotyk Admin",
      },
      "bonbeauty",
      "kremidotyk",
      warnings,
      "vendor_accounts[bonbeauty/kremidotyk/admin@kremidotyk.pl]"
    )

    expect(warnings).toEqual([])
    expect(authService.updateAuthIdentities).toHaveBeenCalledWith({
      id: "auth_1",
      app_metadata: {
        user_id: "user_1",
        member_id: "member_1",
      },
    })
    expect(sellerService.createSellerMembers).toHaveBeenCalledWith([
      expect.objectContaining({
        seller_id: "seller_1",
        member_id: "member_1",
        role_id: "role_seller_administration",
        is_owner: true,
      }),
    ])
  })

  it("adds a warning and skips when the market seller cannot be resolved safely", async () => {
    const authService = {
      listAuthIdentities: jest.fn().mockResolvedValue([]),
      retrieveAuthIdentity: jest.fn(),
      updateAuthIdentities: jest.fn(),
      createAuthIdentities: jest.fn(),
    }

    const sellerService = {
      list: jest.fn().mockResolvedValue([
        {
          id: "seller_other_market",
          handle: "kremidotyk",
          metadata: { gp: { market_id: "mercur" } },
        },
      ]),
      upsertMembers: jest.fn(),
      listSellerMembers: jest.fn(),
      createSellerMembers: jest.fn(),
    }

    const warnings: string[] = []

    await ensureVendorSellerAccess(
      sellerService as any,
      authService as any,
      {
        email: "admin+kremidotyk@kremidotyk.pl",
        password: "Secret123!",
        display_name: "Kremidotyk Admin",
      },
      "bonbeauty",
      "kremidotyk",
      warnings,
      "vendor_accounts[bonbeauty/kremidotyk/admin+kremidotyk@kremidotyk.pl]"
    )

    expect(warnings).toEqual([
      "vendor_accounts[bonbeauty/kremidotyk/admin+kremidotyk@kremidotyk.pl]: seller auth provisioning skipped — cross-market guard — entity belongs to 'mercur'",
    ])
    expect(sellerService.upsertMembers).not.toHaveBeenCalled()
    expect(authService.createAuthIdentities).not.toHaveBeenCalled()
  })
})