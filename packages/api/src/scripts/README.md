# Custom CLI Script

A custom CLI script is a function to execute through Medusa's CLI tool.
This is useful when creating custom Medusa tooling to run as a CLI tool.

> Learn more about custom CLI scripts in [this documentation](https://docs.medusajs.com/learn/fundamentals/custom-cli-scripts).

## How to Create a Custom CLI Script?

To create a custom CLI script, create a TypeScript or JavaScript file
under the `src/scripts` directory. The file must default export a function.

For example, create the file `src/scripts/my-script.ts` with the following content:

```ts title="src/scripts/my-script.ts"
import { 
  ExecArgs,
} from "@medusajs/framework/types"

export default async function myScript ({
  container
}: ExecArgs) {
  const productModuleService = container.resolve("product")

  const [, count] = await productModuleService.listAndCountProducts()

  console.log(`You have ${count} product(s)`)
}
```

The function receives as a parameter an object having a `container`
property, which is an instance of the Medusa Container. Use it to
resolve resources in your Medusa application.

---

## How to Run Custom CLI Script?

To run the custom CLI script, run the `exec` command:

```bash
npx medusa exec ./src/scripts/my-script.ts
```

---

## Custom CLI Script Arguments

Your script can accept arguments from the command line. Arguments are
passed to the function's object parameter in the `args` property.

For example:

```ts
import { ExecArgs } from "@medusajs/framework/types"

export default async function myScript ({
  args
}: ExecArgs) {
  console.log(`The arguments you passed: ${args}`)
}
```

Then, pass the arguments in the `exec` command after the file path:

```bash
npx medusa exec ./src/scripts/my-script.ts arg1 arg2
```

## GP scripts in this repo

```bash
pnpm run db:migrate:all
pnpm run db:migrate:app:status
yarn gp-config-sync-catalog gp-dev bonbeauty
yarn gp-config-sync-translations gp-dev bonbeauty
yarn gp-config-sync-i18n-content gp-dev bonbeauty --dry-run
yarn gp-config-sync-vendors gp-dev bonbeauty
yarn gp-config-sync-payments gp-dev bonbeauty
yarn gp-config-sync-orchestrator gp-dev bonbeauty
```

### App-level migration commands

- `pnpm run db:migrate:all`
  Runs standard Medusa/module migrations first, then the canonical GP app-level migration runner for `packages/api/src/migrations`.
- `pnpm run db:migrate:app:status`
  Shows the current `app_mikro_orm_migrations` ledger state and pending canonical app migrations.
- `pnpm run db:migrate:app`
  Adopts already-present app migration effects into `app_mikro_orm_migrations` and applies runnable canonical app migrations from `packages/api/src/migrations`.
- `pnpm run db:migrate:legacy-base:status`
  Shows the separate `legacy_base_mikro_orm_migrations` ledger for historical base-runtime migrations stored in `packages/api/src/migrations-legacy-base`.
- `pnpm run db:migrate:legacy-base`
  Runs only the separated historical base-runtime migrations. Use this surface only against databases that also contain the prerequisite base tables such as `ledger_entry`, `market_runtime_config`, and `event_store`.

### Current local runtime snapshot

- `pnpm run db:migrate:app:status` -> `executed=9`, `pending=0`
- `pnpm run db:migrate:legacy-base:status` -> `executed=0`, `pending=3`
