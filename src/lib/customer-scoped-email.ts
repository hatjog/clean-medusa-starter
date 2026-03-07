export const CUSTOMER_EMAIL_SCOPE_SEPARATOR = "::";
export const CUSTOMER_MARKET_FORBIDDEN_MESSAGE =
  "Customer not found in this market";

export type CustomerMetadata = {
  gp?: {
    market_id?: string | null;
  } | null;
} | null;

export type CustomerLike = {
  email?: string | null;
  metadata?: CustomerMetadata;
};

export type NotificationServiceLike = {
  createNotifications?: (data: unknown, ...rest: unknown[]) => Promise<unknown>;
  send?: (data: unknown, ...rest: unknown[]) => Promise<unknown>;
  __gpCustomerEmailsPatched?: boolean;
};

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function parseScopedCustomerEmail(email?: string | null): {
  marketId: string;
  email: string;
} | null {
  if (!email) {
    return null;
  }

  const normalized = normalizeEmail(email);
  const separatorIndex = normalized.indexOf(CUSTOMER_EMAIL_SCOPE_SEPARATOR);

  if (separatorIndex <= 0) {
    return null;
  }

  return {
    marketId: normalized.slice(0, separatorIndex),
    email: normalized.slice(
      separatorIndex + CUSTOMER_EMAIL_SCOPE_SEPARATOR.length
    ),
  };
}

export function unscopeCustomerEmail(email?: string | null): string | null {
  if (!email) {
    return null;
  }

  const scoped = parseScopedCustomerEmail(email);
  if (!scoped) {
    return email;
  }

  return scoped.email;
}

export function scopeCustomerEmail(email: string, marketId: string): string {
  const baseEmail = normalizeEmail(unscopeCustomerEmail(email) ?? email);

  return `${marketId}${CUSTOMER_EMAIL_SCOPE_SEPARATOR}${baseEmail}`;
}

export function isScopedToMarket(
  email: string | null | undefined,
  marketId: string
): boolean {
  return parseScopedCustomerEmail(email)?.marketId === marketId;
}

export function mergeCustomerMarketMetadata(
  metadata: Record<string, unknown> | null | undefined,
  marketId: string
): Record<string, unknown> {
  const safeMetadata =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? metadata
      : {};
  const gp =
    safeMetadata.gp &&
    typeof safeMetadata.gp === "object" &&
    !Array.isArray(safeMetadata.gp)
      ? (safeMetadata.gp as Record<string, unknown>)
      : {};

  return {
    ...safeMetadata,
    gp: {
      ...gp,
      market_id: marketId,
    },
  };
}

export function resolveCustomerMarketId(
  customer: CustomerLike | null | undefined
): string | null {
  const metadataMarketId = customer?.metadata?.gp?.market_id;

  if (typeof metadataMarketId === "string" && metadataMarketId.length > 0) {
    return metadataMarketId;
  }

  return parseScopedCustomerEmail(customer?.email)?.marketId ?? null;
}

function shouldSanitizeEmailKey(key: string): boolean {
  return ["email", "to", "cc", "bcc", "reply_to"].includes(key);
}

function sanitizeNode(value: unknown, key?: string): unknown {
  if (typeof value === "string") {
    return key && shouldSanitizeEmailKey(key)
      ? unscopeCustomerEmail(value)
      : value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeNode(entry, key));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const result: Record<string, unknown> = {};

  for (const [entryKey, entryValue] of Object.entries(value)) {
    result[entryKey] = sanitizeNode(entryValue, entryKey);
  }

  return result;
}

export function sanitizeCustomerEmailInObject<T>(value: T): T {
  return sanitizeNode(value) as T;
}

// Patches the notification service to strip scoped email prefixes before
// dispatching. Medusa v2 uses `createNotifications` as the primary dispatch
// method. If future versions introduce additional dispatch methods, they
// should be patched here as well.
export function patchNotificationServiceCustomerEmails(
  notificationService: NotificationServiceLike
): void {
  if (!notificationService || notificationService.__gpCustomerEmailsPatched) {
    return;
  }

  if (typeof notificationService.createNotifications === "function") {
    const originalCreateNotifications =
      notificationService.createNotifications.bind(notificationService);

    notificationService.createNotifications = async (
      data: unknown,
      ...rest: unknown[]
    ) => {
      return originalCreateNotifications(
        sanitizeCustomerEmailInObject(data),
        ...rest
      );
    };
  }

  if (typeof notificationService.send === "function") {
    const originalSend = notificationService.send.bind(notificationService);

    notificationService.send = async (
      data: unknown,
      ...rest: unknown[]
    ) => {
      return originalSend(sanitizeCustomerEmailInObject(data), ...rest);
    };
  }

  Object.defineProperty(notificationService, "__gpCustomerEmailsPatched", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: true,
  });
}