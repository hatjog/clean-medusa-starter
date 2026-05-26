import type { NotificationIntent, NotificationProvider } from "./types";

export type ProviderDispatchStatus = "queued" | "sent";

export interface MessagingProviderResponse {
  dispatch_id: string;
  status: ProviderDispatchStatus;
  provider_message_id?: string;
  sent_at?: string;
}

export interface IMessagingProvider {
  readonly key: NotificationProvider;
  send(intent: NotificationIntent): Promise<MessagingProviderResponse>;
}
