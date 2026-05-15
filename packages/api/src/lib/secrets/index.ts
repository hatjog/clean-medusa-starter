export type MarketId =
  | "bonbeauty"
  | "bonevent"
  | "bongarden"
  | "mercur"
  | "testmarketb"

export type SecretType = "secret" | "publishable" | "webhook"

export const PAYMENT_PROVIDER_NOT_CONFIGURED = "PAYMENT_PROVIDER_NOT_CONFIGURED"

export interface SecretsAdapter {
  getStripeKey(market: MarketId, type: SecretType): Promise<string>
}
