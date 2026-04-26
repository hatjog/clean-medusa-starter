# Backend — MedusaJS 2 (Mercur fork)

## Stack lokalny
- MedusaJS 2 (fork Mercur) + PostgreSQL 17 + Redis 7 + MinIO (S3)
- TypeScript strict, Vitest

## Struktura
- `src/api/` — API routes
- `src/modules/` — domain modules (products, orders, etc.)
- `src/workflows/` — Medusa workflow steps (long-running, transactional)
- `src/subscribers/` — event handlers
- `src/jobs/` — background tasks
- `src/admin/` — admin customizations
- `src/links/` — module links / relations
- `src/loaders/` — bootstrap loaders
- `src/__tests__/` — unit testy
- `integration-tests/` — testy integracyjne (na żywym DB)

## Konwencje
- Każdy module ma własny container scope. Nie importuj usług bezpośrednio — używaj container.resolve() lub workflow steps.
- Subscribery nie modyfikują state'u synchronicznie — wystawiają events / triggerują jobs.
- Migracje DB: Medusa migrations w `src/modules/<module>/migrations/`.

## Testy
- Unit: `cd GP/backend && npx vitest run --reporter=verbose <plik>`
- Integration: `cd GP/backend && npx jest --config integration-tests/...` (sprawdź `package.json` scripts)
- Per `bmad-code-review-fix-runner`: tests muszą przejść po fixach.
