import { describe, expect, test } from "bun:test";
import type { TaskRunView } from "@hraness/agent-tasks-protocol";
import { renderToStaticMarkup } from "react-dom/server";

import { createTaskSubmitLabel, TaskWorkspace } from "./task-workspace";
import {
  reviewTaskDetailFixture,
  taskWorkspaceEmptyFixture,
  taskWorkspaceErrorFixture,
  taskWorkspaceExpiredClaimFixture,
  taskWorkspaceLoadingFixture,
  taskWorkspaceReadyFixture,
} from "./task-workspace-fixtures";
import type { TaskWorkspaceProps } from "./task-workspace-state";

function render(props: TaskWorkspaceProps): string {
  return renderToStaticMarkup(<TaskWorkspace {...props} />);
}

function renderRunPhase(
  phase: TaskRunView["phase"],
  desiredState: TaskRunView["desiredState"] = "run",
): { html: string; runId: string } {
  const read = taskWorkspaceReadyFixture.read;
  if (read.kind !== "ready" || read.selection.kind !== "ready") {
    throw new Error("ready fixture must retain a selected detail");
  }
  const run = read.selection.detail.runs[0];
  if (run === undefined) throw new Error("ready fixture must retain a run");
  return {
    html: render({
      ...taskWorkspaceReadyFixture,
      read: {
        ...read,
        selection: {
          detail: {
            ...read.selection.detail,
            runs: [{ ...run, desiredState, phase }],
          },
          kind: "ready",
        },
      },
    }),
    runId: run.id,
  };
}

function openingTagContaining(html: string, marker: string): string {
  const markerIndex = html.indexOf(marker);
  if (markerIndex === -1) return "";
  const start = html.lastIndexOf("<button", markerIndex);
  const end = html.indexOf(">", markerIndex);
  return start === -1 || end === -1 ? "" : html.slice(start, end + 1);
}

describe("shared TaskWorkspace presentational states", () => {
  test("renders an account-free local owner as the active viewer", () => {
    const html = render({
      ...taskWorkspaceReadyFixture,
      viewer: {
        id: "install_0123456789ABCDEFGHJKMNPQRS",
        kind: "local_owner",
        name: "This Mac",
      },
    });

    expect(html).toContain("Local owner · This Mac");
    expect(html).toContain("task-actor--local_owner");
  });

  test("labels dispatch readiness for the selected repository instead of another ready mapping", () => {
    const readyRepository = taskWorkspaceReadyFixture.runner.repositories[0];
    if (readyRepository === undefined) throw new Error("ready fixture must retain a repository");
    const repositories = [
      readyRepository,
      { ...readyRepository, id: "repo_offline", name: "Offline repository", ready: false },
    ];

    expect(createTaskSubmitLabel(readyRepository.id, repositories)).toBe("Create and dispatch");
    expect(createTaskSubmitLabel(readyRepository.id, repositories, false)).toBe("Create and queue");
    expect(createTaskSubmitLabel("repo_offline", repositories)).toBe("Create and queue");
    expect(createTaskSubmitLabel("repo_unknown", repositories)).toBe("Create and queue");
  });

  test("renders a precise loading fixture", () => {
    const html = render(taskWorkspaceLoadingFixture);
    expect(html).toContain("Loading all tasks");
    expect(html).toContain('role="status"');
    expect(html).toContain("jungle-spinner");
  });

  test("renders an actionable empty ready queue", () => {
    const html = render(taskWorkspaceEmptyFixture);
    expect(html).toContain("No ready tasks");
    expect(html).toContain("Check blocked, deferred, or attention views");
    expect(html).toContain("jungle-empty-state");
  });

  test("renders a sanitized error fixture with its support reference", () => {
    const html = render(taskWorkspaceErrorFixture);
    expect(html).toContain("Attention view unavailable");
    expect(html).toContain("SERVICE_UNAVAILABLE");
    expect(html).toContain("req_fixture");
    expect(html).toContain("jungle-inline-alert");
  });
});

describe("TaskWorkspace rich work surface", () => {
  test("uses mode-neutral workspace copy for provisioning and legacy event kinds", () => {
    const read = taskWorkspaceReadyFixture.read;
    if (read.kind !== "ready" || read.selection.kind !== "ready") {
      throw new Error("ready fixture must retain a selected detail");
    }
    const detail = read.selection.detail;
    const run = detail.runs[0];
    if (run === undefined) throw new Error("ready fixture must retain a run");
    const html = render({
      ...taskWorkspaceReadyFixture,
      read: {
        ...read,
        selection: {
          detail: {
            ...detail,
            runs: [{
              ...run,
              events: [{
                id: "event_workspacepreparing0000001",
                kind: "worktree.preparing",
                observedAt: taskWorkspaceReadyFixture.now - 1_000,
                sequence: 1,
              }],
              phase: "provisioning",
            }],
          },
          kind: "ready",
        },
      },
    });

    expect(html).toContain("Preparing execution workspace");
    expect(html).not.toContain("Preparing worktree");
    expect(html).not.toContain("isolated worktree");
  });

  test("covers every queue and preserves distinct actor identities", () => {
    const html = render(taskWorkspaceReadyFixture);
    for (const label of ["All", "Ready", "Blocked", "Deferred", "Attention", "Assigned", "Review"]) {
      expect(html).toContain(`>${label} ·`);
    }
    expect(html).toContain("Human · Mara Chen");
    expect(html).toContain("Agent · Build Scout");
    expect(html).toContain("System · claim expiry");
  });

  test("renders graph, comments, references, immutable evidence, and review controls", () => {
    const html = render(taskWorkspaceReadyFixture);
    expect(html).toContain("Relationships");
    expect(html).toContain("cancelled blocker");
    expect(html).toContain("Comments");
    expect(html).toContain("References");
    expect(html).toContain("Ready to review");
    expect(html).toContain("Frozen at review revision");
    expect(html).toContain("Accept");
    expect(html).toContain("Reject");
    expect(html).toContain('data-task-review-action="accept"');
    expect(html).toContain('data-task-review-action="reject"');
    expect(html).toContain('role="listbox"');
    expect(html).toContain('role="option"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Remove auth label"');
    expect(html).not.toContain(">×<");
    expect(html).toContain("jungle-button");
    expect(html).toContain("jungle-page-intro");
    expect(html).toContain("jungle-disclosure task-advanced");
    expect(html).toContain("jungle-select-field task-filter");
    expect(html).toContain("Runner ready");
    expect(html).not.toContain("HRA ready");
    expect(html).not.toContain("Open the desktop");
    expect(html).toContain("Submitted for review");
    expect(html).not.toContain("task-detail-tabs");
    expect(html).not.toContain("task-view-navigation");
    expect(html).not.toContain("/Users/");
  });

  test("renders a bounded provider-declared non-secret HITL question without provider details", () => {
    const read = taskWorkspaceReadyFixture.read;
    if (read.kind !== "ready" || read.selection.kind !== "ready") {
      throw new Error("ready fixture must retain a selected detail");
    }
    const detail = read.selection.detail;
    const run = detail.runs[0];
    if (run === undefined) throw new Error("ready fixture must retain a run");
    const html = render({
      ...taskWorkspaceReadyFixture,
      read: {
        ...read,
        selection: {
          kind: "ready",
          detail: {
            ...detail,
            runs: [{
              ...run,
              phase: "waiting",
              interactions: [{
                runId: run.id,
                request: {
                  id: "interaction_webquestion0001",
                  kind: "user_input",
                  createdAt: taskWorkspaceReadyFixture.now - 1_000,
                  expiresAt: taskWorkspaceReadyFixture.now + 60_000,
                  questions: [{
                    id: "question_releasechoice001",
                    header: "Release",
                    prompt: "Which release lane should continue?",
                    allowOther: true,
                    options: [{
                      id: "option_canaryrelease001",
                      label: "Canary",
                      description: "Use the staged release lane.",
                    }],
                  }],
                },
                state: "pending",
              }],
            }],
          },
        },
      },
    });
    expect(html).toContain("Codex has a question");
    expect(html).toContain("Which release lane should continue?");
    expect(html).toContain("Canary");
    expect(html).toContain("Continue");
    expect(html).toContain('type="checkbox"');
    expect(html).toMatch(
      /<div class="jungle-checkbox-field task-interaction-option">[\s\S]*?<label class="jungle-checkbox-field__control">[\s\S]*?Use the staged release lane\.[\s\S]*?<\/label><\/div>/u,
    );
    expect(html).toMatch(/aria-labelledby="[^"]+-label"/u);
    expect(html).toMatch(/aria-describedby="[^"]+-description"/u);
    expect(html).toContain('<p class="jungle-visually-hidden" role="alert">Needs your input. Which release lane should continue?</p>');
    expect(html).toContain('<div aria-label="Run needs input" class="task-interactions">');
    expect(html).not.toContain('aria-label="Run needs input" aria-live');
    expect(html).not.toContain("providerRequestId");
    expect(html).not.toContain("/Users/");
  });

  test("orders pending HITL by request time and id instead of storage order", () => {
    const read = taskWorkspaceReadyFixture.read;
    if (read.kind !== "ready" || read.selection.kind !== "ready") {
      throw new Error("ready fixture must retain a selected detail");
    }
    const detail = read.selection.detail;
    const run = detail.runs[0];
    if (run === undefined) throw new Error("ready fixture must retain a run");
    const question = (id: string, createdAt: number, prompt: string) => ({
      runId: run.id,
      request: {
        id,
        kind: "user_input" as const,
        createdAt,
        expiresAt: taskWorkspaceReadyFixture.now + 60_000,
        questions: [{
          id: `question_${id}`,
          header: "Verification",
          prompt,
          allowOther: true,
          options: [],
        }],
      },
      state: "pending" as const,
    });
    const laterId = "interaction_webapprovalz001";
    const earlierId = "interaction_webapprovala001";
    const laterPrompt = "Should the later request appear second?";
    const earlierPrompt = "Should the earlier request appear first?";
    const html = render({
      ...taskWorkspaceReadyFixture,
      read: {
        ...read,
        selection: {
          detail: {
            ...detail,
            runs: [{
              ...run,
              interactions: [
                question(laterId, taskWorkspaceReadyFixture.now - 1_000, laterPrompt),
                question(earlierId, taskWorkspaceReadyFixture.now - 1_000, earlierPrompt),
              ],
              phase: "waiting",
            }],
          },
          kind: "ready",
        },
      },
    });

    expect(html.indexOf(earlierPrompt)).toBeLessThan(html.indexOf(laterPrompt));
  });

  test("honestly queues new work when the desktop lease is offline", () => {
    const html = render({
      ...taskWorkspaceReadyFixture,
      runner: {
        ...taskWorkspaceReadyFixture.runner,
        presence: { serverTime: taskWorkspaceReadyFixture.now, state: "offline" },
      },
    });
    expect(html).toContain("Runner offline");
    expect(html).toContain("Tasks stay queued");
  });

  test("fails closed when a task-list HITL preview expires", () => {
    const read = taskWorkspaceReadyFixture.read;
    if (read.kind !== "ready") throw new Error("ready fixture must retain a task list");
    const first = read.tasks[0];
    if (first === undefined) throw new Error("ready fixture must retain one task");
    const preview = "This expired question must not be promoted.";
    const html = render({
      ...taskWorkspaceReadyFixture,
      read: {
        ...read,
        tasks: [{
          ...first,
          humanInput: {
            expiresAt: taskWorkspaceReadyFixture.now,
            kind: "user_input",
            oldestRequestedAt: taskWorkspaceReadyFixture.now - 1_000,
            pendingCount: 1,
            preview,
          },
        }],
      },
    });

    expect(html).not.toContain(preview);
    expect(html).not.toContain('data-needs-input="true"');
  });

  test("shows an anonymous tool timer only while the run is actively running", () => {
    const read = taskWorkspaceReadyFixture.read;
    if (read.kind !== "ready" || read.selection.kind !== "ready") {
      throw new Error("ready fixture must retain a selected detail");
    }
    const detail = read.selection.detail;
    const run = detail.runs[0];
    if (run === undefined) throw new Error("ready fixture must retain a run");
    const events = [...run.events, {
      id: "event_tooltimer0000000000000001",
      kind: "codex.tool_activity.started" as const,
      observedAt: taskWorkspaceReadyFixture.now - 90_000,
      sequence: run.events.length + 1,
    }];
    const withPhase = (phase: typeof run.phase) => render({
      ...taskWorkspaceReadyFixture,
      read: {
        ...read,
        selection: {
          detail: {
            ...detail,
            runs: [{ ...run, events, phase }],
          },
          kind: "ready",
        },
      },
    });

    const running = withPhase("running");
    expect(running).toContain("Calling tools");
    expect(running).toContain("1m 30s");
    expect(running).toContain('aria-live="polite" class="jungle-visually-hidden task-stream-announcement"');
    expect(running).toContain('<div class="task-transcript" aria-label="Codex updates">');
    expect(running).not.toContain('aria-label="Codex updates" aria-live');
    expect(running).toContain('<p class="task-tool-activity" data-stream-kind="tools"><span>Calling tools</span><span aria-hidden="true">1m 30s</span></p>');
    expect(running).not.toContain('data-stream-kind="tools" role="status"');
    expect(withPhase("failed")).not.toContain("Calling tools");
  });

  test("does not repeat an identical terminal event below the phase heading", () => {
    const submitted = renderRunPhase("submitted").html;
    expect(submitted).toContain("Submitted for review");
    expect(submitted).not.toContain('class="task-stream__quiet-status">Submitted for review</p>');
  });

  test("offers one specific stop control only while a run is active", () => {
    for (const phase of ["leased", "provisioning", "starting", "running", "waiting"] as const) {
      const { html, runId } = renderRunPhase(phase);
      expect(html).toContain(`aria-label="Stop run ${runId}"`);
      expect(html).toContain("Stop run");
    }

    const queued = renderRunPhase("queued");
    expect(queued.html).toContain(`aria-label="Stop run ${queued.runId}"`);
    expect(queued.html).toContain("Stop run");

    for (const phase of ["submitted", "failed", "cancelled", "ambiguous"] as const) {
      const { html, runId } = renderRunPhase(phase);
      expect(html).not.toContain(`aria-label="Stop run ${runId}"`);
      expect(html).not.toContain("Stop requested");
    }
  });

  test("locks task inputs while a dispatch may still own local effects", () => {
    for (const phase of ["queued", "running", "cancel_requested", "ambiguous"] as const) {
      const { html } = renderRunPhase(phase, phase === "cancel_requested" ? "stop" : "run");
      expect(html).toContain("Task fields are locked while this dispatch may own local effects");
      expect(html).not.toContain(">Edit task</button>");
      expect(html).not.toContain(">Cancel task</button>");
      expect(html).toContain("Add a human supervision note");
    }
  });

  test("keeps the visible stop label stable after the request is acknowledged", () => {
    const { html, runId } = renderRunPhase("cancel_requested", "stop");
    const label = `aria-label="Stop requested for run ${runId}"`;

    expect(html).toContain(label);
    expect(html).toContain("Stop run");
    expect(html).not.toContain(">Stop requested<");
    expect(openingTagContaining(html, label)).toContain("disabled");
    expect(html).not.toContain(`aria-label="Stop run ${runId}"`);
  });

  test("retries proved terminals and quarantines ambiguous work until explicit resolution", () => {
    for (const phase of ["failed", "cancelled"] as const) {
      const { html, runId } = renderRunPhase(phase);
      expect(html).toContain(`aria-label="Retry run ${runId}"`);
      expect(html).toContain("Retry creates a new queued run");
      expect(html).not.toContain("Resolve ambiguity");
    }

    const ambiguous = renderRunPhase("ambiguous");
    expect(ambiguous.html).toContain("Resolve ambiguity");
    expect(ambiguous.html).toContain("Do not retry until you confirm the session stopped");
    expect(ambiguous.html).not.toContain(`aria-label="Retry run ${ambiguous.runId}"`);
  });

  test("hides dispatch recovery controls without human dispatch authority", () => {
    for (const phase of ["failed", "cancelled", "ambiguous"] as const) {
      const read = taskWorkspaceReadyFixture.read;
      if (read.kind !== "ready" || read.selection.kind !== "ready") {
        throw new Error("ready fixture must retain a selected detail");
      }
      const run = read.selection.detail.runs[0];
      if (run === undefined) throw new Error("ready fixture must retain a run");
      const html = render({
        ...taskWorkspaceReadyFixture,
        capabilities: { ...taskWorkspaceReadyFixture.capabilities, canCreate: false },
        read: {
          ...read,
          selection: {
            detail: {
              ...read.selection.detail,
              runs: [{ ...run, phase }],
            },
            kind: "ready",
          },
        },
      });
      expect(html).not.toContain(`aria-label="Retry run ${run.id}"`);
      expect(html).not.toContain("Resolve ambiguity");
    }
  });

  test("does not offer run control without planner capability", () => {
    const read = taskWorkspaceReadyFixture.read;
    if (read.kind !== "ready" || read.selection.kind !== "ready") {
      throw new Error("ready fixture must retain a selected detail");
    }
    const run = read.selection.detail.runs[0];
    if (run === undefined) throw new Error("ready fixture must retain a run");
    const html = render({
      ...taskWorkspaceReadyFixture,
      capabilities: { ...taskWorkspaceReadyFixture.capabilities, canCancel: false },
      read: {
        ...read,
        selection: {
          detail: {
            ...read.selection.detail,
            runs: [{ ...run, phase: "running" }],
          },
          kind: "ready",
        },
      },
    });

    expect(html).not.toContain(`aria-label="Stop run ${run.id}"`);
  });

  test("discloses bounded detail collections instead of implying complete history", () => {
    const readyRead = taskWorkspaceReadyFixture.read;
    if (readyRead.kind !== "ready") throw new Error("ready fixture must remain ready");
    const html = renderToStaticMarkup(
      <TaskWorkspace
        {...taskWorkspaceReadyFixture}
        read={{
          ...readyRead,
          selection: {
            detail: {
              ...reviewTaskDetailFixture,
              truncatedCollections: ["comments", "events"],
            },
            kind: "ready",
          },
        }}
      />,
    );

    expect(html).toContain("bounded comments, events results");
    expect(html).toContain("available from the workspace authority");
    expect(html).not.toContain("taskctl");
  });

  test("renders revocation and cancelled-blocker recovery without bearer material", () => {
    const html = render(taskWorkspaceReadyFixture);
    expect(html).toContain("Agent access was revoked");
    expect(html).toContain("Cancelled blocker needs a decision");
    expect(html).toContain("never paste bearer material");
    expect(html).not.toContain("credential_secret");
  });

  test("renders an expired claim with its stale fence recovery", () => {
    const html = render(taskWorkspaceExpiredClaimFixture);
    expect(html).toContain("Current claim");
    expect(html).toContain("Expired");
    expect(html).toContain("Claim lease expired");
    expect(html).toContain("The old fence is stale");
  });

  test("renders rejected-submission recovery while preserving old evidence", () => {
    const readyRead = taskWorkspaceReadyFixture.read;
    if (readyRead.kind !== "ready") throw new Error("ready fixture must remain ready");
    const rejectedDetail = {
      ...reviewTaskDetailFixture,
      submission: reviewTaskDetailFixture.submission === null
        ? null
        : {
            ...reviewTaskDetailFixture.submission,
            reviewReason: "The concurrency proof did not cover a delayed session heartbeat.",
            reviewedAt: taskWorkspaceReadyFixture.now - 300_000,
            status: "rejected" as const,
          },
    };
    const rejected: TaskWorkspaceProps = {
      ...taskWorkspaceReadyFixture,
      read: {
        ...readyRead,
        selection: { detail: rejectedDetail, kind: "ready" },
      },
    };
    const html = render(rejected);
    expect(html).toContain("Submission rejected");
    expect(html).toContain("stay immutable");
    expect(html).toContain("delayed session heartbeat");
    expect(html).toContain("bun run test:local:human");
    const submittedRun = rejectedDetail.runs.find(
      ({ phase }) => phase === "submitted",
    );
    if (submittedRun === undefined) {
      throw new Error("rejected fixture must retain its submitted run");
    }
    expect(html).toContain(`aria-label="Retry run ${submittedRun.id}"`);
    expect(html).toContain("attempt and its submission are immutable");
  });
});
