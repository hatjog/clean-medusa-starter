export class WalletPayloadError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = "WalletPayloadError"
  }
}
