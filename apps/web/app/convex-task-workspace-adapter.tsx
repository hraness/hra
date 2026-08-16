"use client";

import {
  TaskWorkspaceClientView,
  createTaskWorkspaceClient,
  createTaskWorkspaceClientHost,
} from "@hraness/agent-tasks-ui";
import { useConvex } from "convex/react";
import {
  useEffect,
  useMemo,
} from "react";

import { createConvexHostedMutationAttemptJournal } from "./hosted-mutation-attempt-journal";
import { createHostedTaskWorkspaceSource } from "./hosted-task-workspace-source";

/**
 * Hosted composition for the provider-free task feature. Convex owns one
 * atomic watched root; the shared client owns selection, paging, mutation
 * fences, and React-facing snapshots.
 */
export function ConvexTaskWorkspaceAdapter({
  workspaceId,
}: Readonly<{ workspaceId: string }>) {
  const convex = useConvex();
  const host = useMemo(
    () => createTaskWorkspaceClientHost({
      selectedTaskId: null,
      view: "all",
      workspaceId,
    }),
    [workspaceId],
  );

  useEffect(() => {
    const mutationJournal = createConvexHostedMutationAttemptJournal({
      client: convex,
      workspaceId,
    });
    const source = createHostedTaskWorkspaceSource({
      client: convex,
      mutationJournal,
      workspaceId,
    });
    const client = createTaskWorkspaceClient({
      coordinate: {
        selectedTaskId: null,
        view: "all",
        workspaceId,
      },
      source,
    });
    const uninstall = host.install(client);
    return () => {
      uninstall();
      source.dispose();
    };
  }, [convex, host, workspaceId]);

  return <TaskWorkspaceClientView client={host.client} />;
}
