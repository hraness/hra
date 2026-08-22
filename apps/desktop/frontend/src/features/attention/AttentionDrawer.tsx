import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  attentionGroup,
  attentionItemKey,
  type AttentionGroup,
  type AttentionItem,
} from "@hraness/hra-local-observation-protocol/attention";

import type {
  RuntimeAttentionProjection,
  RuntimeDomainCommand,
} from "../../../../contracts/runtime";
import type { RuntimeShell } from "../../runtime";
import { Button, IconButton } from "../../ui";
import { HRAIcon } from "../chat/Icon";

type LoadState = "idle" | "loading" | "ready" | "error";
type PaneAttentionReason = Extract<
  AttentionItem,
  { readonly source: "pane" }
>["reason"];
type ChatAttentionReason = Extract<
  PaneAttentionReason,
  { readonly kind: "chat_attention" }
>;
type SetupApprovalReason = Extract<
  PaneAttentionReason,
  { readonly kind: "workspace_setup_approval_required" }
>;

const groupOrder = ["recovery", "needs_you", "review"] as const;
const groupLabels: Readonly<Record<AttentionGroup, string>> = {
  recovery: "Recovery",
  needs_you: "Needs you",
  review: "Review",
};

const chatReasonLabels: Readonly<Record<ChatAttentionReason["code"], string>> = {
  account_required: "A Codex account is required",
  account_unavailable: "The selected Codex account is unavailable",
  usage_limit_reached: "The weekly usage limit was reached",
  all_accounts_exhausted: "Every connected Codex account is unavailable",
  continuation_failed: "The conversation could not continue safely",
  approval_required: "Codex needs a decision",
  runtime_unavailable: "The local runtime is unavailable",
  turn_failed: "The latest turn failed",
};

const setupFailureLabels: Readonly<Record<
  Extract<
    Extract<AttentionItem, { readonly source: "pane" }>["reason"],
    { readonly kind: "workspace_setup_failed" }
  >["setupOutcome"],
  string
>> = {
  clean_replacement_required:
    "Replace this pane with a clean managed workspace. Setup will not retry",
  invalid_recipe: "The workspace recipe is invalid",
  runtime_unavailable: "Workspace setup could not start",
  exit_nonzero: "Workspace setup failed",
  timeout: "Workspace setup timed out",
  output_limit: "Workspace setup exceeded its output limit",
  containment_failed: "Workspace setup failed containment checks",
  transcript_unavailable: "Workspace setup evidence is unavailable",
};

const systemLabels: Readonly<Record<
  Extract<AttentionItem, { readonly source: "system" }>["reason"],
  string
>> = {
  local_runtime_unavailable: "The local HRA runtime is unavailable",
  folder_access_missing: "Choose the folder available to every pane",
  codex_account_required: "Connect a Codex subscription",
  runner_configuration: "The task runner needs configuration",
  runner_connection: "The task runner is disconnected",
  runner_repository_missing: "The task runner needs a repository mapping",
  human_account_recovery: "HRA Cloud sign-in needs recovery",
  human_account_attention: "HRA Cloud needs attention",
  session_sync_attention: "Encrypted session sync needs attention",
  session_sync_recovery: "Encrypted session sync needs recovery",
  scheduled_chat_recovery: "A scheduled chat needs recovery",
};

export interface AttentionItemPresentation {
  readonly detail: string | null;
  readonly label: string;
}

export function workspaceSetupApprovalCommand(
  reason: SetupApprovalReason,
): Extract<RuntimeDomainCommand, { readonly type: "workspace.setup.approve" }> {
  return {
    type: "workspace.setup.approve",
    setupRequestId: reason.setupRequestId,
    recipeDigest: reason.recipeDigest,
    expectedSetupRevision: reason.setupRevision,
  };
}

export async function dispatchWorkspaceSetupApproval(
  shell: Pick<RuntimeShell, "dispatch">,
  reason: SetupApprovalReason,
): Promise<void> {
  const response = await shell.dispatch(workspaceSetupApprovalCommand(reason));
  if (
    !response.ok ||
    response.result.type !== "workspaceSetupApproval" ||
    response.result.setupRequestId !== reason.setupRequestId ||
    response.result.recipeDigest !== reason.recipeDigest
  ) throw new Error("The runtime did not accept the exact workspace setup approval.");
}

export function presentAttentionItem(item: AttentionItem): AttentionItemPresentation {
  switch (item.source) {
    case "pane": {
      let label: string;
      switch (item.reason.kind) {
        case "ambiguous_delivery":
          label = "Message delivery is uncertain";
          break;
        case "workspace_setup_ambiguous":
          label =
            "Replace this pane with a clean managed workspace. Setup will not retry";
          break;
        case "workspace_setup_approval_required":
          label = "Approve locked Bun install (scripts disabled)";
          break;
        case "workspace_setup_failed":
          label = setupFailureLabels[item.reason.setupOutcome];
          break;
        case "workspace_recovery":
          label = "The managed workspace needs recovery";
          break;
        case "chat_attention":
          label = chatReasonLabels[item.reason.code];
          break;
        case "queue_paused":
          label = "The message queue is paused";
          break;
      }
      return {
        label,
        detail: item.repositoryName === null
          ? item.title
          : `${item.title} · ${item.repositoryName}`,
      };
    }
    case "account":
      return {
        label: item.reason === "expired"
          ? "Reconnect this Codex subscription"
          : item.reason === "runtime_unavailable"
            ? "This Codex runtime is unavailable"
            : "This Codex subscription has no weekly capacity",
        detail: item.label,
      };
    case "workspace": {
      const count = item.count.capped ? `${item.count.value}+` : String(item.count.value);
      return {
        label: item.reason === "task_review"
          ? `${count} ${item.count.value === 1 && !item.count.capped ? "task is" : "tasks are"} ready for review`
          : `${count} ${item.count.value === 1 && !item.count.capped ? "task needs" : "tasks need"} attention`,
        detail: item.name,
      };
    }
    case "system":
      return { label: systemLabels[item.reason], detail: null };
  }
}

function completenessMessage(
  completeness: RuntimeAttentionProjection["completeness"],
): string | null {
  switch (completeness) {
    case "complete":
      return null;
    case "cloud_refreshing":
      return "Cloud task status is refreshing. Local attention is current.";
    case "cloud_unavailable":
      return "Cloud task status is unavailable. Local attention is still available.";
    case "task_authority_unavailable":
      return "Task attention is unavailable. Local attention is still available.";
    case "workspace_limit_reached":
      return "Some workspace attention is not shown. Local recovery items remain prioritized.";
  }
}

export function AttentionDrawerPanel({
  approvalErrorRequestId,
  approvingSetupRequestId,
  loadState,
  onApproveSetup,
  onClose,
  onRefresh,
  panelId,
  projection,
  titleId,
}: Readonly<{
  approvalErrorRequestId: string | null;
  approvingSetupRequestId: string | null;
  loadState: LoadState;
  onApproveSetup: (reason: SetupApprovalReason) => void;
  onClose: () => void;
  onRefresh: () => void;
  panelId: string;
  projection: RuntimeAttentionProjection | null;
  titleId: string;
}>) {
  const grouped = new Map<AttentionGroup, AttentionItem[]>();
  for (const item of projection?.items ?? []) {
    const group = attentionGroup(item);
    const values = grouped.get(group) ?? [];
    values.push(item);
    grouped.set(group, values);
  }
  const partialMessage = projection === null
    ? null
    : completenessMessage(projection.completeness);

  return (
    <aside
      aria-labelledby={titleId}
      aria-modal="false"
      className="attention-drawer"
      id={panelId}
      role="dialog"
    >
      <div className="attention-drawer__header">
        <div>
          <h2 id={titleId}>Attention</h2>
          <p>Local recovery, decisions, and reviews</p>
        </div>
        <div className="attention-drawer__actions">
          <IconButton
            aria-label="Refresh attention"
            controlClassName="attention-drawer__icon-button"
            isPending={loadState === "loading"}
            onPress={onRefresh}
            size="compact"
            tooltip="Refresh"
            type="button"
          >
            <HRAIcon name="refresh" />
          </IconButton>
          <IconButton
            aria-label="Close attention"
            controlClassName="attention-drawer__icon-button"
            onPress={onClose}
            size="compact"
            tooltip="Close"
            type="button"
          >
            <HRAIcon name="close" />
          </IconButton>
        </div>
      </div>
      {partialMessage === null ? null : (
        <p className="attention-drawer__partial" role="status">{partialMessage}</p>
      )}
      {(loadState === "idle" || loadState === "loading") && projection === null ? (
        <p aria-live="polite" className="attention-drawer__empty">Checking attention…</p>
      ) : loadState === "error" && projection === null ? (
        <p className="attention-drawer__error" role="alert">
          Attention could not be refreshed.
        </p>
      ) : projection?.items.length === 0 ? (
        <p className="attention-drawer__empty">Nothing needs your attention.</p>
      ) : (
        <div className="attention-drawer__groups">
          {groupOrder.map((group) => {
            const items = grouped.get(group) ?? [];
            if (items.length === 0) return null;
            return (
              <section className="attention-drawer__group" data-attention-group={group} key={group}>
                <h3>{groupLabels[group]}</h3>
                <ul>
                  {items.map((item) => {
                    const presentation = presentAttentionItem(item);
                    const approvalReason = item.source === "pane" &&
                        item.reason.kind === "workspace_setup_approval_required"
                      ? item.reason
                      : null;
                    const approvalTitle = item.source === "pane" ? item.title : "pane";
                    return (
                      <li data-attention-source={item.source} key={attentionItemKey(item)}>
                        <span aria-hidden="true" className="attention-drawer__marker" />
                        <span className="attention-drawer__copy">
                          <strong>{presentation.label}</strong>
                          {presentation.detail === null ? null : <span>{presentation.detail}</span>}
                        </span>
                        {approvalReason === null ? null : (
                          <Button
                            aria-label={`Approve locked Bun install for ${approvalTitle}`}
                            controlClassName="attention-drawer__approve"
                            isDisabled={
                              approvingSetupRequestId !== null &&
                              approvingSetupRequestId !== approvalReason.setupRequestId
                            }
                            isPending={approvingSetupRequestId === approvalReason.setupRequestId}
                            onPress={() => onApproveSetup(approvalReason)}
                            size="compact"
                            type="button"
                            variant="secondary"
                          >
                            Approve
                          </Button>
                        )}
                        {approvalReason !== null &&
                            approvalErrorRequestId === approvalReason.setupRequestId ? (
                          <span className="attention-drawer__item-error" role="alert">
                            Approval was not accepted. Refresh and try again.
                          </span>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
      )}
      {loadState === "error" && projection !== null ? (
        <p className="attention-drawer__error" role="alert">
          Attention could not be refreshed. Showing the last result.
        </p>
      ) : null}
    </aside>
  );
}

export function AttentionDrawer({
  isAvailable,
  refreshKey,
  shell,
}: Readonly<{
  isAvailable: boolean;
  refreshKey: string;
  shell: RuntimeShell | null;
}>) {
  const panelId = useId();
  const titleId = `${panelId}-title`;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const requestGeneration = useRef(0);
  const mounted = useRef(true);
  const openRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [projection, setProjection] = useState<RuntimeAttentionProjection | null>(null);
  const [approvingSetupRequestId, setApprovingSetupRequestId] = useState<string | null>(null);
  const [approvalErrorRequestId, setApprovalErrorRequestId] = useState<string | null>(null);
  const lastRefreshKey = useRef<string | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestGeneration.current += 1;
    };
  }, []);
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  const refresh = useCallback(async () => {
    if (shell === null || !isAvailable) return;
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    setLoadState("loading");
    try {
      const response = await shell.dispatch({ type: "observation.attention.list" });
      if (!response.ok || response.result.type !== "attentionProjection") {
        throw new Error("The runtime did not return an attention projection.");
      }
      if (!mounted.current || requestGeneration.current !== generation) return;
      setProjection(response.result.projection);
      setLoadState("ready");
    } catch {
      if (!mounted.current || requestGeneration.current !== generation) return;
      setLoadState("error");
    }
  }, [isAvailable, shell]);

  useEffect(() => {
    if (!isAvailable || shell === null) return;
    void refresh();
  }, [isAvailable, refresh, shell]);

  useEffect(() => {
    if (lastRefreshKey.current === null) {
      lastRefreshKey.current = refreshKey;
      return;
    }
    if (
      lastRefreshKey.current === refreshKey ||
      !isAvailable ||
      shell === null
    ) return;
    lastRefreshKey.current = refreshKey;
    const timeout = setTimeout(() => void refresh(), 250);
    return () => clearTimeout(timeout);
  }, [isAvailable, refresh, refreshKey, shell]);

  useEffect(() => {
    if (shell === null) return;
    return shell.subscribeTaskInvalidations(() => {
      if (isAvailable) void refresh();
    });
  }, [isAvailable, refresh, shell]);

  const approveSetup = useCallback(async (reason: SetupApprovalReason) => {
    if (shell === null || !isAvailable || approvingSetupRequestId !== null) return;
    setApprovingSetupRequestId(reason.setupRequestId);
    setApprovalErrorRequestId(null);
    try {
      await dispatchWorkspaceSetupApproval(shell, reason);
      await refresh();
    } catch {
      if (mounted.current) setApprovalErrorRequestId(reason.setupRequestId);
    } finally {
      if (mounted.current) setApprovingSetupRequestId(null);
    }
  }, [approvingSetupRequestId, isAvailable, refresh, shell]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  const itemCount = projection?.items.length ?? 0;
  const triggerLabel = itemCount === 0
    ? "Attention"
    : `Attention, ${itemCount} ${itemCount === 1 ? "item" : "items"}`;
  return (
    <div className="attention-control" ref={rootRef}>
      <IconButton
        aria-controls={panelId}
        aria-expanded={open}
        aria-label={triggerLabel}
        buttonRef={triggerRef}
        controlClassName="attention-control__trigger"
        data-attention-count={itemCount}
        isDisabled={!isAvailable || shell === null}
        onPress={() => {
          setOpen((current) => !current);
          if (!open) void refresh();
        }}
        size="compact"
        tooltip="Attention"
        type="button"
      >
        <span aria-hidden="true" className="attention-control__glyph">!</span>
        {itemCount === 0 ? null : (
          <span aria-hidden="true" className="attention-control__count">
            {itemCount > 99 ? "99+" : itemCount}
          </span>
        )}
      </IconButton>
      {open ? (
        <AttentionDrawerPanel
          approvalErrorRequestId={approvalErrorRequestId}
          approvingSetupRequestId={approvingSetupRequestId}
          loadState={loadState}
          onApproveSetup={(reason) => void approveSetup(reason)}
          onClose={() => {
            setOpen(false);
            triggerRef.current?.focus();
          }}
          onRefresh={() => void refresh()}
          panelId={panelId}
          projection={projection}
          titleId={titleId}
        />
      ) : null}
    </div>
  );
}
