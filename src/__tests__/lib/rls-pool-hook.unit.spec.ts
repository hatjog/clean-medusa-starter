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
    installRlsPoolHook(harness.pgConnection);

    await marketContextStorage.run(
      { market_id: "bonbeauty", sales_channel_id: "sc_001" },
      async () => {
        await harness.client.acquireConnection();
      }
    );

    expect(harness.connection.query).toHaveBeenNthCalledWith(1, "SET ROLE medusa_store");
    expect(harness.connection.query).toHaveBeenNthCalledWith(
      2,
      "SELECT set_config('app.gp_market_id', 'bonbeauty', false)"
    );
  });

  it("skips pool mutation when ALS context is missing", async () => {
    const harness = createHarness();
    installRlsPoolHook(harness.pgConnection);

    await harness.client.acquireConnection();

    expect(harness.connection.query).not.toHaveBeenCalled();
  });

  it("rejects invalid market ids instead of interpolating them", async () => {
    const harness = createHarness();
    installRlsPoolHook(harness.pgConnection);

    await marketContextStorage.run(
      { market_id: "bad'value", sales_channel_id: "sc_001" },
      async () => {
        await harness.client.acquireConnection();
      }
    );

    expect(harness.connection.query).not.toHaveBeenCalled();
  });

  it("resets app config and role on release for marked connections", async () => {
    const harness = createHarness();
    installRlsPoolHook(harness.pgConnection);

    const connection = await marketContextStorage.run(
      { market_id: "bonevent", sales_channel_id: "sc_002" },
      async () => harness.client.acquireConnection()
    );

    harness.connection.query.mockClear();
    await harness.client.releaseConnection(connection);

    expect(harness.connection.query).toHaveBeenNthCalledWith(
      1,
      "RESET app.gp_market_id"
    );
    expect(harness.connection.query).toHaveBeenNthCalledWith(2, "RESET ROLE");
    expect(harness.originalReleaseConnection).toHaveBeenCalledWith(connection);
  });

  it("destroys dirty connections when reset fails", async () => {
    const harness = createHarness();
    installRlsPoolHook(harness.pgConnection);

    const connection = await marketContextStorage.run(
      { market_id: "bonevent", sales_channel_id: "sc_002" },
      async () => harness.client.acquireConnection()
    );

    harness.connection.query.mockReset();
    harness.connection.query.mockRejectedValueOnce(new Error("reset failed"));

    await harness.client.releaseConnection(connection);

    expect(harness.client.destroyRawConnection).toHaveBeenCalledWith(connection);
    expect(harness.originalReleaseConnection).not.toHaveBeenCalledWith(connection);
  });

  it("installs independently for multiple pg clients", async () => {
    const first = createHarness();
    const second = createHarness();

    installRlsPoolHook(first.pgConnection);
    installRlsPoolHook(second.pgConnection);

    await marketContextStorage.run(
      { market_id: "bonbeauty", sales_channel_id: "sc_001" },
      async () => {
        await first.client.acquireConnection();
        await second.client.acquireConnection();
      }
    );

    expect(first.connection.query).toHaveBeenCalled();
    expect(second.connection.query).toHaveBeenCalled();
  });
});