import { z } from "zod";

import {
  parseNotificationEmailPolicyResult,
  type NotificationEmailContractIssue,
  type NotificationEmailPolicy,
} from "./notification-email-contract";

export type { NotificationEmailPolicy };

export const notificationEmailPolicySchema = z.unknown().transform(
  (value, context): NotificationEmailPolicy => {
    const result = parseNotificationEmailPolicyResult(value);
    if (result.success) return result.data;
    for (const issue of result.issues) {
      const contractIssue: NotificationEmailContractIssue = issue;
      context.addIssue({
        code: "custom",
        message: contractIssue.message,
        path: [...contractIssue.path],
      });
    }
    return z.NEVER;
  },
);
