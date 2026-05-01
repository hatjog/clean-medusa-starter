import {
  mergeCustomerMarketMetadata,
  patchNotificationServiceCustomerEmails,
  resolveCustomerMarketId,
  sanitizeCustomerEmailInObject,
  scopeCustomerEmail,
  unscopeCustomerEmail,
} from "../../lib/customer-scoped-email";

describe("customer scoped auth identity helpers", () => {
  it("allows the same raw email to map to different stored emails per market", () => {
    const email = "User@Test.local";

    expect(scopeCustomerEmail(email, "bonbeauty")).toBe(
      "bonbeauty::user@test.local"
    );
    expect(scopeCustomerEmail(email, "bonevent")).toBe(
      "bonevent::user@test.local"
    );
  });

  it("resolves customer market from metadata and strips prefixes for display", () => {
    const scopedEmail = scopeCustomerEmail("user@test.local", "bonbeauty");

    expect(unscopeCustomerEmail(scopedEmail)).toBe("user@test.local");
    expect(
      resolveCustomerMarketId({
        email: scopedEmail,
        metadata: mergeCustomerMarketMetadata({}, "bonbeauty"),
      })
    ).toBe("bonbeauty");
    expect(
      sanitizeCustomerEmailInObject({ customer: { email: scopedEmail } })
    ).toEqual({ customer: { email: "user@test.local" } });
  });

  it("does not alter non-scoped emails during sanitization", () => {
    const vendorEmail = "Vendor@Example.COM";

    expect(unscopeCustomerEmail(vendorEmail)).toBe(vendorEmail);
    expect(
      sanitizeCustomerEmailInObject({ seller: { email: vendorEmail } })
    ).toEqual({ seller: { email: vendorEmail } });
  });

  it("sanitizes notification recipients before dispatch", async () => {
    const originalCreateNotifications = jest.fn().mockResolvedValue(undefined);
    const notificationService = {
      createNotifications: originalCreateNotifications,
    };

    patchNotificationServiceCustomerEmails(notificationService);

    await notificationService.createNotifications({
      to: scopeCustomerEmail("user@test.local", "bonbeauty"),
      channel: "email",
    });

    expect(originalCreateNotifications).toHaveBeenCalledWith({
      to: "user@test.local",
      channel: "email",
    });
  });

  it("sanitizes notification send method as well", async () => {
    const originalSend = jest.fn().mockResolvedValue(undefined);
    const notificationService = {
      createNotifications: jest.fn(),
      send: originalSend,
    };

    patchNotificationServiceCustomerEmails(notificationService);

    await notificationService.send({
      to: scopeCustomerEmail("user@test.local", "bonbeauty"),
    });

    expect(originalSend).toHaveBeenCalledWith({
      to: "user@test.local",
    });
  });

  it("sanitizes array-based recipient fields", () => {
    expect(
      sanitizeCustomerEmailInObject({
        cc: [
          scopeCustomerEmail("alpha@test.local", "bonbeauty"),
          scopeCustomerEmail("beta@test.local", "bonevent"),
        ],
      })
    ).toEqual({
      cc: ["alpha@test.local", "beta@test.local"],
    });
  });

  it("patches notification service only once", async () => {
    const originalSend = jest.fn().mockResolvedValue(undefined);
    const notificationService = {
      send: originalSend,
    };

    patchNotificationServiceCustomerEmails(notificationService);
    patchNotificationServiceCustomerEmails(notificationService);

    await notificationService.send({
      to: scopeCustomerEmail("user@test.local", "bonbeauty"),
    });

    expect(originalSend).toHaveBeenCalledTimes(1);
    expect(originalSend).toHaveBeenCalledWith({
      to: "user@test.local",
    });
  });
});