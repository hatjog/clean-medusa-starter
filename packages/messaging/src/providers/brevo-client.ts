export interface BrevoEmailAddress {
  email: string;
  name?: string;
}

export interface BrevoTransactionalEmailPayload {
  templateId: number;
  to: BrevoEmailAddress[];
  sender: BrevoEmailAddress;
  params: Record<string, unknown>;
  headers: Record<string, string>;
}

export interface BrevoSendResponse {
  messageId?: string;
  "message-id"?: string;
  message_id?: string;
  provider_message_id?: string;
  [key: string]: unknown;
}

export interface IBrevoClient {
  sendTransacEmail(
    payload: BrevoTransactionalEmailPayload,
  ): Promise<BrevoSendResponse>;
}
