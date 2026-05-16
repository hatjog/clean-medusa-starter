describe.skip("Sprint 5 gate: Stripe Path Y lifecycle", () => {
  it("F-NEW-B1 keeps 2x parallel checkout submits to exactly one PaymentIntent and entitlement", async () => {
    // Sprint 5 live gate: requires running storefront + backend + Stripe test mode.
    // Execute two concurrent checkout submits with the same Idempotency-Key and
    // assert one PaymentIntent, one webhook_event_processed row, and one ACTIVE
    // entitlement_instance for the order.
  })

  it("F-NEW-E2 replays full chain after kill-mid-flow during payment.captured", async () => {
    // Sprint 5 live gate: requires controllable backend process and Stripe test
    // webhook delivery. Kill the subscriber between payment.captured receipt and
    // completion, then retry delivery and assert no partial state remains.
  })
})
