import { z } from "zod";

import { readBoundedJsonResponse } from "./bounded-json-response";
import { publicRepository } from "./release-distribution-policy";

const repositoryId = 1_343_008_607;
const repositoryOwnerId = 307_125_679;
const maximumRepositoryBytes = 128 * 1_024;

const repositorySchema = z.object({
  default_branch: z.literal("main"),
  full_name: z.literal(publicRepository),
  id: z.literal(repositoryId),
  owner: z.object({ id: z.literal(repositoryOwnerId) }),
  private: z.literal(false),
  visibility: z.literal("public"),
});

export function assertLiveReleaseRepository(value: unknown): void {
  const parsed = repositorySchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Publication requires the exact live public HRA repository identity.");
  }
}

export async function fetchLiveReleaseRepository(token: string | undefined): Promise<void> {
  if (token === undefined || token.length < 1 || token.length > 8_192) {
    throw new Error("Live release repository verification requires one bounded GitHub token.");
  }
  const response = await fetch(`https://api.github.com/repos/${publicRepository}`, {
    cache: "no-store",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Cache-Control": "no-cache",
      "User-Agent": "hraness-release-publication",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status !== 200) {
    throw new Error(`Live release repository verification returned HTTP ${String(response.status)}.`);
  }
  assertLiveReleaseRepository(await readBoundedJsonResponse(
    response,
    "Live release repository verification",
    maximumRepositoryBytes,
  ));
}
