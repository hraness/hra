import type { ApprovalMode, InteractionDisplay, InteractionKind } from "./interactions";

export type ProtocolAutorespondAuthorityDecision =
  | Readonly<{ action: "accept"; decision: "once"; approvalClass: string }>
  | Readonly<{
      action: "escalate";
      code: "manual_mode" | "not_an_approval" | "decision_unavailable" | "protected_authority_required";
      approvalClass: string;
    }>;

/** Bounded presentation evidence only, never proof of grant authority. */
export function approvalClassOf(display: InteractionDisplay): string {
  switch (display.kind) {
    case "command_approval": return `command:${display.commandClass}`.slice(0, 256);
    case "file_change_approval": return "file_change";
    case "permission_approval": {
      const names = display.requested.map((permission) => permission.name).join(",");
      return `permission:${names.length === 0 ? "unknown" : names}`.slice(0, 256);
    }
    case "user_input": return "user_input";
    case "mcp_elicitation": return "mcp_elicitation";
  }
}

/** Policy eligibility only. Final provider verification and budget admission remain required. */
export function decideProtocolAutorespondAuthority(input: Readonly<{
  display: InteractionDisplay;
  kind: InteractionKind;
  mode: ApprovalMode;
}>): ProtocolAutorespondAuthorityDecision {
  const approvalClass = approvalClassOf(input.display);
  if (input.mode === "manual") return { action: "escalate", code: "manual_mode", approvalClass };
  if (
    input.kind !== "command_approval"
    && input.kind !== "file_change_approval"
    && input.kind !== "permission_approval"
  ) return { action: "escalate", code: "not_an_approval", approvalClass };
  if (input.display.kind !== input.kind) return { action: "escalate", code: "not_an_approval", approvalClass };
  // The pinned file-change callback has no exact affected paths. Workspace
  // command and permission labels likewise cannot attest private authority.
  if (input.display.kind === "file_change_approval"
    || (input.display.kind === "command_approval" && input.mode === "auto:workspace")) {
    return { action: "escalate", code: "protected_authority_required", approvalClass };
  }
  if (input.display.kind === "permission_approval") {
    if (input.display.requested.length === 0) {
      return { action: "escalate", code: "decision_unavailable", approvalClass };
    }
    if (input.mode === "auto:workspace") {
      return { action: "escalate", code: "protected_authority_required", approvalClass };
    }
  } else if (!input.display.availableDecisions.includes("once")) {
    return { action: "escalate", code: "decision_unavailable", approvalClass };
  }
  return { action: "accept", decision: "once", approvalClass };
}
