/**
 * posthog-loader.unit.spec.ts — Story 2.5 (R-2.5-H2).
 *
 * Loader domyka nośnik metryk jobów. Dwa niezmienniki, na których stoi AC3:
 *   1. klucz kontenera `"posthog"` REALNIE powstaje (bez tego wszystkie
 *      `capture` w jobach są ciche — dokładnie stan sprzed tej poprawki);
 *   2. brak `POSTHOG_API_KEY` nie wywraca bootu, ale zostawia `warn`.
 */

import posthogLoader from "../../loaders/posthog"
import {
  __resetPosthogMetricsClientForTests,
  POSTHOG_CONTAINER_KEY,
} from "../../lib/instrumentation/posthog-metrics-client"

type Registration = Record<string, { resolve?: unknown }>

function makeContainer() {
  const registered: Registration = {}
  const warnings: string[] = []
  return {
    registered,
    warnings,
    container: {
      resolve: (key: string) => {
        if (key === "logger") {
          return { warn: (message: string) => warnings.push(message) }
        }
        throw new Error(`nieznany klucz kontenera: ${key}`)
      },
      register: (entry: Registration) => Object.assign(registered, entry),
    },
  }
}

describe("posthogLoader — nośnik metryk jobów istnieje w runtime", () => {
  const env = process.env

  beforeEach(() => {
    process.env = { ...env }
    __resetPosthogMetricsClientForTests(null)
  })

  afterEach(() => {
    process.env = env
    __resetPosthogMetricsClientForTests(null)
  })

  it("rejestruje klucz `posthog` w kontenerze", async () => {
    const { container, registered } = makeContainer()

    await posthogLoader({ container: container as never })

    expect(Object.keys(registered)).toContain(POSTHOG_CONTAINER_KEY)
  })

  it("brak `POSTHOG_API_KEY` nie wywraca bootu, ale nie jest ciszą", async () => {
    delete process.env.POSTHOG_API_KEY
    const { container, registered, warnings } = makeContainer()

    await expect(
      posthogLoader({ container: container as never }),
    ).resolves.toBeUndefined()

    expect(Object.keys(registered)).toContain(POSTHOG_CONTAINER_KEY)
    expect(warnings.some((message) => message.includes("POSTHOG_API_KEY"))).toBe(
      true,
    )
  })

  it("boot bez `BREVO_API_KEY` też przechodzi — loader nie zna providera maili", async () => {
    delete process.env.BREVO_API_KEY
    delete process.env.POSTHOG_API_KEY
    const { container } = makeContainer()

    await expect(
      posthogLoader({ container: container as never }),
    ).resolves.toBeUndefined()
  })
})
