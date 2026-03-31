import { ExecArgs } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"

import fs from "node:fs/promises"
import path from "node:path"

import * as yaml from "js-yaml"

import scryptKdf from "scrypt-kdf"

import { GP_CORE_MODULE } from "../modules/gp-core"
import GpCoreService from "../modules/gp-core/service"
import { scopeCustomerEmail, mergeCustomerMarketMetadata } from "../lib/customer-scoped-email"

// ---- Types ----

type AccountBase = {
  email: string
  password: string
  display_name: string
}

type InstanceAccount = AccountBase & {
  role: string
}

type MarketAccount = AccountBase & {
  role: string
}

type MarketAccountGroup = {
  market_id: string
  accounts: MarketAccount[]
}

type VendorAccount = AccountBase & {
  role: string
}

type VendorAccountGroup = {
  market_id: string
  vendor_id: string
  accounts: VendorAccount[]
}

type CustomerAccount = AccountBase & {
  first_name: string
  last_name: string
  markets: string[]
}

type AccountsConfig = {
  version: string
  instance_id: string
  instance_accounts?: InstanceAccount[]
  market_accounts?: MarketAccountGroup[]
  vendor_accounts?: VendorAccountGroup[]
  customer_accounts?: CustomerAccount[]
}

type OpCounts = { created: number; skipped: number }

type SyncSummary = {
  ok: boolean
  instance_id: string
  config_root: string
  accounts_path: string
  instance_accounts: OpCounts
  market_accounts: OpCounts
  vendor_accounts: OpCounts
  customer_accounts: OpCounts
  warnings: string[]
  timestamp: string
}

// ---- Utilities (pattern from gp-config-sync-catalog) ----

function parseArgs(args: string[] | undefined): {
  instanceId: string
  configRoot: string
} {
  const instanceId = (args?.[0] ?? process.env.GP_INSTANCE_ID ?? "gp-dev").trim()
  const configRoot = (
    process.env.GP_CONFIG_ROOT ?? path.resolve(process.cwd(), "../config")
  ).trim()

  if (!instanceId) throw new Error("instanceId is required (args[0] or GP_INSTANCE_ID)")
  if (!configRoot) throw new Error("configRoot is required (GP_CONFIG_ROOT)")

  return { instanceId, configRoot }
}

async function readYamlFile<T>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, "utf8")
  const doc = yaml.load(raw, { schema: yaml.JSON_SCHEMA })
  if (!doc || typeof doc !== "object") {
    throw new Error(`Invalid YAML document: ${filePath}`)
  }
  return doc as T
}

function resolveService(container: any, keysToTry: string[]): any {
  const errors: string[] = []
  for (const key of keysToTry) {
    try {
      return container.resolve(key)
    } catch (e: any) {
      errors.push(`${key}: ${e?.message ?? String(e)}`)
    }
  }
  throw new Error(
    `Cannot resolve service. Tried keys: ${keysToTry.join(", ")}. Errors: ${errors.join(" | ")}`
  )
}

// ---- Service type interfaces ----

type UserModuleService = {
  listUsers: (filters?: Record<string, unknown>, config?: Record<string, unknown>) => Promise<any[]>
  createUsers: (data: any[]) => Promise<any[]>
  updateUsers: (data: any) => Promise<any>
}

type AuthModuleService = {
  createAuthIdentities: (data: any[]) => Promise<any[]>
  listAuthIdentities: (filters?: Record<string, unknown>, config?: Record<string, unknown>) => Promise<any[]>
  retrieveAuthIdentity: (id: string) => Promise<any>
  updateAuthIdentities: (data: any) => Promise<any>
}

type CustomerModuleService = {
  listCustomers: (filters?: Record<string, unknown>, config?: Record<string, unknown>) => Promise<any[]>
  createCustomers: (data: any[]) => Promise<any[]>
  updateCustomers: (id: string, data: any) => Promise<any>
}

// ---- Sync helpers ----

async function findUserByEmail(
  userService: UserModuleService,
  email: string
): Promise<any | null> {
  const users = await userService.listUsers({ email }, { take: 1 })
  return users?.[0] ?? null
}

async function findCustomerByEmail(
  customerService: CustomerModuleService,
  scopedEmail: string
): Promise<any | null> {
  const customers = await customerService.listCustomers({ email: scopedEmail }, { take: 1 })
  return customers?.[0] ?? null
}

// Cached auth identity lookup — loaded once per sync run, then reused
let _authIdentityCache: Map<string, any> | null = null

async function loadAuthIdentityCache(
  authService: AuthModuleService
): Promise<Map<string, any>> {
  if (_authIdentityCache) return _authIdentityCache
  const identities = await authService.listAuthIdentities(
    {},
    { relations: ["provider_identities"], take: null }
  )
  _authIdentityCache = new Map<string, any>()
  for (const identity of identities ?? []) {
    for (const pi of identity.provider_identities ?? []) {
      if (pi.provider === "emailpass" && pi.entity_id) {
        _authIdentityCache.set(pi.entity_id, identity)
      }
    }
  }
  return _authIdentityCache
}

async function findAuthIdentityByEntityId(
  authService: AuthModuleService,
  entityId: string
): Promise<any | null> {
  const cache = await loadAuthIdentityCache(authService)
  return cache.get(entityId) ?? null
}

const SCRYPT_HASH_CONFIG = { logN: 15, r: 8, p: 1 }

async function hashPassword(password: string): Promise<string> {
  const buf = await scryptKdf.kdf(password, SCRYPT_HASH_CONFIG)
  return buf.toString("base64")
}

async function ensureAuthIdentity(
  authService: AuthModuleService,
  email: string,
  password: string,
  warnings: string[],
  context: string
): Promise<string | null> {
  const existing = await findAuthIdentityByEntityId(authService, email)
  if (existing) {
    return existing.id
  }

  try {
    const passwordHash = await hashPassword(password)
    const [identity] = await authService.createAuthIdentities([
      {
        provider_identities: [
          {
            provider: "emailpass",
            entity_id: email,
            provider_metadata: { password: passwordHash },
          },
        ],
      },
    ])
    // Update cache with newly created identity
    if (identity && _authIdentityCache) {
      _authIdentityCache.set(email, identity)
    }
    return identity?.id ?? null
  } catch (e: any) {
    warnings.push(`${context}: auth identity creation failed — ${e?.message ?? String(e)}`)
    return null
  }
}

async function linkAuthIdentityToActor(
  authService: AuthModuleService,
  authIdentityId: string,
  actorType: "user" | "customer",
  actorId: string,
  warnings: string[],
  context: string
): Promise<void> {
  const key = `${actorType}_id`
  try {
    const authIdentity = await authService.retrieveAuthIdentity(authIdentityId)
    const appMetadata = authIdentity.app_metadata || {}
    if (appMetadata[key] === actorId) {
      return // Already linked
    }
    appMetadata[key] = actorId
    await authService.updateAuthIdentities({
      id: authIdentityId,
      app_metadata: appMetadata,
    })
  } catch (e: any) {
    warnings.push(`${context}: auth identity linking failed — ${e?.message ?? String(e)}`)
  }
}

async function ensureAdminUser(
  userService: UserModuleService,
  authService: AuthModuleService,
  account: AccountBase & { role?: string },
  warnings: string[],
  context: string
): Promise<{ userId: string; created: boolean } | null> {
  let existingUser: any | null
  try {
    existingUser = await findUserByEmail(userService, account.email)
  } catch (e: any) {
    warnings.push(`${context}: user lookup failed — ${e?.message ?? String(e)}`)
    return null
  }
  if (existingUser) {
    // Update display_name if changed
    try {
      await userService.updateUsers({
        id: existingUser.id,
        first_name: account.display_name,
      })
    } catch (e: any) {
      warnings.push(`${context}: user update failed — ${e?.message ?? String(e)}`)
    }
    // Ensure auth identity is linked (fix for previously created but unlinked accounts)
    const existingAuthId = await ensureAuthIdentity(authService, account.email, account.password, warnings, context)
    if (existingAuthId) {
      await linkAuthIdentityToActor(authService, existingAuthId, "user", existingUser.id, warnings, context)
    }
    return { userId: existingUser.id, created: false }
  }

  const authIdentityId = await ensureAuthIdentity(
    authService,
    account.email,
    account.password,
    warnings,
    context
  )
  if (!authIdentityId) {
    return null
  }

  try {
    const [user] = await userService.createUsers([
      {
        email: account.email,
        first_name: account.display_name,
      },
    ])

    // Link auth identity → user (sets app_metadata.user_id)
    await linkAuthIdentityToActor(authService, authIdentityId, "user", user.id, warnings, context)

    return { userId: user.id, created: true }
  } catch (e: any) {
    warnings.push(`${context}: user creation failed — ${e?.message ?? String(e)}`)
    return null
  }
}

// ---- Level sync functions ----

async function syncInstanceAccounts(
  accounts: InstanceAccount[],
  userService: UserModuleService,
  authService: AuthModuleService,
  warnings: string[]
): Promise<OpCounts> {
  const counts: OpCounts = { created: 0, skipped: 0 }

  for (const account of accounts) {
    const result = await ensureAdminUser(
      userService,
      authService,
      account,
      warnings,
      `instance_accounts[${account.email}]`
    )
    if (result) {
      result.created ? counts.created++ : counts.skipped++
      console.log(
        `  Instance admin '${account.email}': ${result.created ? "CREATED" : "EXISTS (updated)"}`
      )
    }
  }

  return counts
}

async function syncMarketAccounts(
  groups: MarketAccountGroup[],
  instanceId: string,
  gpCoreService: GpCoreService,
  userService: UserModuleService,
  authService: AuthModuleService,
  warnings: string[]
): Promise<OpCounts> {
  const counts: OpCounts = { created: 0, skipped: 0 }

  for (const group of groups) {
    const market = await gpCoreService.getMarketBySlug(instanceId, group.market_id)
    if (!market) {
      warnings.push(`market_accounts: market '${group.market_id}' not found in gp_core — skipping`)
      continue
    }

    for (const account of group.accounts) {
      const context = `market_accounts[${group.market_id}/${account.email}]`
      const result = await ensureAdminUser(userService, authService, account, warnings, context)
      if (!result) continue

      if (result.created) {
        counts.created++
      } else {
        counts.skipped++
      }

      // Upsert membership regardless (role may have changed)
      try {
        await gpCoreService.upsertUserMarketMembership({
          user_id: result.userId,
          instance_id: instanceId,
          market_id: market.id,
          role: account.role,
        })
      } catch (e: any) {
        warnings.push(`${context}: membership upsert failed — ${e?.message ?? String(e)}`)
      }

      console.log(
        `  Market admin '${account.email}' → ${group.market_id} (${account.role}): ${result.created ? "CREATED" : "EXISTS (membership upserted)"}`
      )
    }
  }

  return counts
}

async function syncVendorAccounts(
  groups: VendorAccountGroup[],
  instanceId: string,
  gpCoreService: GpCoreService,
  userService: UserModuleService,
  authService: AuthModuleService,
  warnings: string[]
): Promise<OpCounts> {
  const counts: OpCounts = { created: 0, skipped: 0 }

  for (const group of groups) {
    const vendorId = gpCoreService.buildSeedVendorId(instanceId, group.vendor_id)
    const vendor = await gpCoreService.getVendor(vendorId)
    if (!vendor) {
      warnings.push(
        `vendor_accounts: vendor '${group.vendor_id}' (market '${group.market_id}') not found in gp_core — skipping`
      )
      continue
    }

    for (const account of group.accounts) {
      const context = `vendor_accounts[${group.market_id}/${group.vendor_id}/${account.email}]`
      const result = await ensureAdminUser(userService, authService, account, warnings, context)
      if (!result) continue

      if (result.created) {
        counts.created++
      } else {
        counts.skipped++
      }

      // Upsert membership regardless
      try {
        await gpCoreService.upsertUserVendorMembership({
          user_id: result.userId,
          instance_id: instanceId,
          vendor_id: vendor.id,
          role: account.role,
        })
      } catch (e: any) {
        warnings.push(`${context}: membership upsert failed — ${e?.message ?? String(e)}`)
      }

      console.log(
        `  Vendor admin '${account.email}' → ${group.vendor_id} (${account.role}): ${result.created ? "CREATED" : "EXISTS (membership upserted)"}`
      )
    }
  }

  return counts
}

async function syncCustomerAccounts(
  customers: CustomerAccount[],
  customerService: CustomerModuleService,
  authService: AuthModuleService,
  warnings: string[]
): Promise<OpCounts> {
  const counts: OpCounts = { created: 0, skipped: 0 }

  for (const customer of customers) {
    for (const marketId of customer.markets ?? []) {
      const scopedEmail = scopeCustomerEmail(customer.email, marketId)
      const context = `customer_accounts[${customer.email}@${marketId}]`

      let existing: any | null
      try {
        existing = await findCustomerByEmail(customerService, scopedEmail)
      } catch (e: any) {
        warnings.push(`${context}: customer lookup failed — ${e?.message ?? String(e)}`)
        continue
      }
      if (existing) {
        // Update fields if changed
        try {
          await customerService.updateCustomers(existing.id, {
            first_name: customer.first_name,
            last_name: customer.last_name,
            metadata: mergeCustomerMarketMetadata(existing.metadata, marketId),
          })
        } catch (e: any) {
          warnings.push(`${context}: customer update failed — ${e?.message ?? String(e)}`)
        }
        // Ensure auth identity is linked
        const existingAuthId = await ensureAuthIdentity(authService, scopedEmail, customer.password, warnings, context)
        if (existingAuthId) {
          await linkAuthIdentityToActor(authService, existingAuthId, "customer", existing.id, warnings, context)
        }
        counts.skipped++
        console.log(`  Customer '${customer.email}' → ${marketId}: EXISTS (updated)`)
        continue
      }

      const authIdentityId = await ensureAuthIdentity(
        authService,
        scopedEmail,
        customer.password,
        warnings,
        context
      )
      if (!authIdentityId) continue

      try {
        const [created] = await customerService.createCustomers([
          {
            email: scopedEmail,
            first_name: customer.first_name,
            last_name: customer.last_name,
            metadata: mergeCustomerMarketMetadata(null, marketId),
          },
        ])
        // Link auth identity → customer (sets app_metadata.customer_id)
        await linkAuthIdentityToActor(authService, authIdentityId, "customer", created.id, warnings, context)
        counts.created++
        console.log(`  Customer '${customer.email}' → ${marketId}: CREATED`)
      } catch (e: any) {
        warnings.push(`${context}: customer creation failed — ${e?.message ?? String(e)}`)
      }
    }
  }

  return counts
}

// ---- Main Orchestrator ----

export default async function gpConfigSyncAccounts({ container, args }: ExecArgs) {
  const { instanceId, configRoot } = parseArgs(args)
  const accountsPath = path.resolve(configRoot, instanceId, "accounts.yaml")

  // Check file exists
  try {
    await fs.access(accountsPath)
  } catch {
    console.log(`INFO: accounts.yaml not found at ${accountsPath} — nothing to sync.`)
    return
  }

  // Load accounts config
  const accounts = await readYamlFile<AccountsConfig>(accountsPath)

  // Guard: instance_id mismatch
  if (accounts.instance_id !== instanceId) {
    throw new Error(
      `instance_id mismatch in ${accountsPath}: expected '${instanceId}', got '${accounts.instance_id}'`
    )
  }

  console.log(`Syncing accounts for instance '${instanceId}' (version ${accounts.version})...`)

  const warnings: string[] = []

  // Resolve services
  const userService = resolveService(container, [
    Modules.USER,
    "user",
    "userModuleService",
    "user_module",
  ]) as UserModuleService

  const authService = resolveService(container, [
    Modules.AUTH,
    "auth",
    "authModuleService",
    "auth_module",
  ]) as AuthModuleService

  const customerService = resolveService(container, [
    Modules.CUSTOMER,
    "customer",
    "customerModuleService",
    "customer_module",
  ]) as CustomerModuleService

  const gpCoreService =
    (container.resolve?.(GP_CORE_MODULE) as GpCoreService | undefined) ??
    new GpCoreService(container as Record<string, unknown>, {
      databaseUrl: process.env.GP_CORE_DATABASE_URL,
      mercurDatabaseUrl: process.env.GP_MERCUR_DATABASE_URL,
    })

  // L1: Instance accounts
  console.log("\n--- L1: Instance accounts ---")
  const instanceCounts = await syncInstanceAccounts(
    accounts.instance_accounts ?? [],
    userService,
    authService,
    warnings
  )

  // L2: Market accounts
  console.log("\n--- L2: Market accounts ---")
  const marketCounts = await syncMarketAccounts(
    accounts.market_accounts ?? [],
    instanceId,
    gpCoreService,
    userService,
    authService,
    warnings
  )

  // L3: Vendor accounts
  console.log("\n--- L3: Vendor accounts ---")
  const vendorCounts = await syncVendorAccounts(
    accounts.vendor_accounts ?? [],
    instanceId,
    gpCoreService,
    userService,
    authService,
    warnings
  )

  // L4: Customer accounts
  console.log("\n--- L4: Customer accounts ---")
  const customerCounts = await syncCustomerAccounts(
    accounts.customer_accounts ?? [],
    customerService,
    authService,
    warnings
  )

  // Cleanup
  try {
    await gpCoreService.dispose()
  } catch {
    // ignore dispose errors
  }

  // JSON summary
  const summary: SyncSummary = {
    ok: warnings.length === 0,
    instance_id: instanceId,
    config_root: configRoot,
    accounts_path: accountsPath,
    instance_accounts: instanceCounts,
    market_accounts: marketCounts,
    vendor_accounts: vendorCounts,
    customer_accounts: customerCounts,
    warnings,
    timestamp: new Date().toISOString(),
  }

  console.log("\n" + JSON.stringify(summary, null, 2))

  // Signal warnings via exit code (non-destructive — lets event loop drain)
  if (warnings.length > 0) {
    process.exitCode = 1
  }

  // Reset auth identity cache for next run
  _authIdentityCache = null
}
