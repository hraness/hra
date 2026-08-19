import { dirname, isAbsolute, join } from "node:path";

/** Fixed Application Support sibling shared by live custody, backup, restore, and deletion. */
export const CHAT_ATTACHMENT_VAULT_DIRECTORY_NAME = "attachment-vault-v2" as const;

export function chatAttachmentVaultRoot(controlPlanePath: string): string {
  if (!isAbsolute(controlPlanePath)) {
    throw new Error("Attachment vault resolution requires an absolute control-plane path.");
  }
  return join(dirname(controlPlanePath), CHAT_ATTACHMENT_VAULT_DIRECTORY_NAME);
}
