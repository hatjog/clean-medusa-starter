import type { MedusaContainer } from "@medusajs/types";
import { Modules } from "@medusajs/framework/utils";
import {
  patchNotificationServiceCustomerEmails,
  type NotificationServiceLike,
} from "../lib/customer-scoped-email";

export default async function customerNotificationEmailSanitizerLoader({
  container,
}: {
  container: MedusaContainer;
}): Promise<void> {
  const notificationService = container.resolve(
    Modules.NOTIFICATION
  ) as NotificationServiceLike;

  patchNotificationServiceCustomerEmails(notificationService);
}