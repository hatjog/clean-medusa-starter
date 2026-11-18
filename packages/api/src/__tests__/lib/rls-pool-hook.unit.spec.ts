/**
 * Unit tests for the production RLS pool hook — Story 10-3, Task 5.2 (AC-5)
 */

import {
  _resetRlsPoolHook,
  installRlsPoolHook,
} from "../../lib/rls-pool-hook";
import { marketContextStorage } from "../../lib/market-context";

function createHarness() {
  const connection = {
    query: jest.fn().mockResolvedValue(undefined),
    end: jest.fn().mockResolvedValue(undefined),
  };
  const client = {
    acquireConnection: jest.fn().mockResolvedValue(connection),
    releaseConnection: jest.fn().mockResolvedValue(undefined),
    destroyRawConnection: jest.fn().mockResolvedValue(undefined),
  };

  return {
    client,
    connection,
    logger: {
      warn: jest.fn(),
      error: jest.fn(),
    },
    originalReleaseConnection: client.releaseConnection,
    pgConnection: { client },
  };
}

describe("installRlsPoolHook", () => {
  beforeEach(() => {
    _resetRlsPoolHook();
  });

  it("applies role + market config on acquire when ALS context exists", async () => {
    const harness = createHarness();
    installRlsPoolHook(harness.pgConnection, harness.logger);

    await marketContextStorage.run(
      { market_id: "bonbeauty", instance_id: "gp-test", sales_channel_id: "sc_001" },
      async () => {
        await harness.client.acquireConnection();
      }
    );

    expect(harness.connection.query).toHaveBeenNthCalledWith(1, "SET ROLE medusa_store");
    expect(harness.connection.query).toHaveBeenNthCalledWith(
      2,
      "SELECT set_config('app.gp_market_id', $1, false)",
      ["bonbeauty"]
    );
    expect(harness.connection.query).toHaveBeenNthCalledWith(
      3,
      "SELECT set_config('app.gp_instance_id', $1, false)",
      ["gp-test"]
    );
  });

  it("odmawia i niszczy połączenie when ALS context is missing", async () => {
    const harness = createHarness();
    installRlsPoolHook(harness.pgConnection, harness.logger);

    await expect(harness.client.acquireConnection()).rejects.toEqual(
      expect.objectContaining({ error_code: "GP_RLS_MARKET_CONTEXT_REQUIRED" })
    );

    expect(harness.connection.query).not.toHaveBeenCalled();
    expect(harness.client.destroyRawConnection).toHaveBeenCalledWith(harness.connection);
  });

  it("rejects invalid market ids instead of interpolating them", async () => {
    const harness = createHarness();
    installRlsPoolHook(harness.pgConnection, harness.logger);

    await expect(
      marketContextStorage.run(
        { market_id: "bad'value", instance_id: "gp-test", sales_channel_id: "sc_001" },
        async () => harness.client.acquireConnection()
      )
    ).rejects.toEqual(expect.objectContaining({ error_code: "GP_RLS_MARKET_CONTEXT_REQUIRED" }));

    expect(harness.connection.query).not.toHaveBeenCalled();
    expect(harness.logger.error).toHaveBeenCalledWith(
      "RLS pool hook acquire denied",
      expect.objectContaining({ reason: "invalid_market_id", market_id: "bad'value" })
    );
  });

  it("destroys the connection when acquire hook fails after SET ROLE", async () => {
    const harness = createHarness();
    installRlsPoolHook(harness.pgConnection, harness.logger);

    harness.connection.query
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("set_config failed"))
      .mockResolvedValue(undefined);

    await expect(
      marketContextStorage.run(
        { market_id: "bonbeauty", instance_id: "gp-test", sales_channel_id: "sc_001" },
        async () => harness.client.acquireConnection()
      )
    ).rejects.toThrow("set_config failed");

    expect(harness.client.destroyRawConnection).toHaveBeenCalledWith(
      harness.connection
    );
    expect(harness.logger.error).toHaveBeenCalledWith(
      "RLS pool hook acquire failed",
      expect.objectContaining({ market_id: "bonbeauty", error: "set_config failed" })
    );
  });

  it("resets app config and role on release for marked connections", async () => {
    const harness = createHarness();
    installRlsPoolHook(harness.pgConnection, harness.logger);

    const connection = await marketContextStorage.run(
      { market_id: "bonevent", instance_id: "gp-test", sales_channel_id: "sc_002" },
      async () => harness.client.acquireConnection()
    );

    harness.connection.query.mockClear();
    await harness.client.releaseConnection(connection);

    expect(harness.connection.query).toHaveBeenNthCalledWith(
      1,
      "RESET app.gp_market_id"
    );
    expect(harness.connection.query).toHaveBeenNthCalledWith(2, "RESET app.gp_instance_id");
    expect(harness.connection.query).toHaveBeenNthCalledWith(3, "RESET ROLE");
    expect(harness.originalReleaseConnection).toHaveBeenCalledWith(connection);
  });

  it("destroys dirty connections when reset fails", async () => {
    const harness = createHarness();
    installRlsPoolHook(harness.pgConnection, harness.logger);

    const connection = await marketContextStorage.run(
      { market_id: "bonevent", instance_id: "gp-test", sales_channel_id: "sc_002" },
      async () => harness.client.acquireConnection()
    );

    harness.connection.query.mockReset();
    harness.connection.query.mockRejectedValueOnce(new Error("reset failed"));

    await harness.client.releaseConnection(connection);

    expect(harness.client.destroyRawConnection).toHaveBeenCalledWith(connection);
    // Story 8.7 (DW-15-370): brudne polaczenie wraca do puli jako zuzyte (slot zwolniony).
    expect(harness.originalReleaseConnection).toHaveBeenCalledWith(
      expect.objectContaining({ __knex__disposed: "RLS pool hook release destroy failed" })
    );
    expect(harness.logger.error).toHaveBeenCalledWith(
      "RLS pool hook release cleanup failed",
      expect.objectContaining({ error: "reset failed" })
    );
  });

  it("installs independently for multiple pg clients", async () => {
    const first = createHarness();
    const second = createHarness();

    installRlsPoolHook(first.pgConnection, first.logger);
    installRlsPoolHook(second.pgConnection, second.logger);

    await marketContextStorage.run(
      { market_id: "bonbeauty", instance_id: "gp-test", sales_channel_id: "sc_001" },
      async () => {
        await first.client.acquireConnection();
        await second.client.acquireConnection();
      }
    );

    expect(first.connection.query).toHaveBeenCalled();
    expect(second.connection.query).toHaveBeenCalled();
  });
});
