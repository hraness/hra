import {
  desktopPairingRedeemRequestSchema,
  desktopPairingRedeemResponseSchema,
  desktopPairingStartRequestSchema,
  desktopPairingStartResponseSchema,
  pairedHumanAuthenticationResponseSchema,
  type PairedHumanAuthenticationResponse,
} from "@hraness/agent-tasks-protocol";

const REQUEST_ID = "req_00000000000000000000000000";

interface PairingRecord {
  readonly challenge: string;
  consumed: boolean;
}

export interface FakeDesktopPairing {
  readonly origin: string;
  close(): Promise<void>;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

async function challengeForVerifier(verifier: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return Buffer.from(bytes).toString("base64url");
}

/**
 * Loopback transport fixture for the CLI lane. It exercises the production
 * challenge/verifier and one-time response schemas while returning credentials
 * minted by the real Convex Auth acceptance setup.
 */
export function startFakeDesktopPairing(
  authenticationValue: PairedHumanAuthenticationResponse,
): FakeDesktopPairing {
  const authentication = pairedHumanAuthenticationResponseSchema.parse(authenticationValue);
  const pairings = new Map<string, PairingRecord>();
  let sequence = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/v1/auth/desktop-pairings") {
        const parsed = desktopPairingStartRequestSchema.safeParse(await request.json().catch(() => null));
        if (!parsed.success) return json({ ok: false, error: { code: "INVALID_REQUEST" }, requestId: REQUEST_ID }, 400);
        sequence += 1;
        const pairingId = `pair_${String(sequence).padStart(26, "0")}`;
        pairings.set(pairingId, { challenge: parsed.data.challenge, consumed: false });
        const data = desktopPairingStartResponseSchema.parse({
          pairingId,
          verificationUri: `http://127.0.0.1:${server.port}/pair/desktop/${pairingId}`,
          comparisonCode: "2345-6789",
          expiresAt: Date.now() + 60_000,
          pollIntervalMs: 1_000,
        });
        return json({ ok: true, data, requestId: REQUEST_ID });
      }

      const match = url.pathname.match(
        /^\/v1\/auth\/desktop-pairings\/(pair_[0-9A-HJKMNP-TV-Z]{26})\/redeem$/u,
      );
      if (request.method === "POST" && match !== null) {
        const parsed = desktopPairingRedeemRequestSchema.safeParse(await request.json().catch(() => null));
        if (!parsed.success) return json({ ok: false, error: { code: "INVALID_REQUEST" }, requestId: REQUEST_ID }, 400);
        const pairingId = match[1];
        if (pairingId === undefined) throw new Error("Pairing route omitted its locator.");
        const record = pairings.get(pairingId);
        const status = record === undefined
          ? { status: "expired" as const }
          : record.consumed
            ? { status: "consumed" as const }
            : await challengeForVerifier(parsed.data.verifier) !== record.challenge
              ? { status: "denied" as const }
              : { status: "approved" as const, authentication };
        if (record !== undefined && status.status === "approved") record.consumed = true;
        const data = desktopPairingRedeemResponseSchema.parse(status);
        return json({ ok: true, data, requestId: REQUEST_ID });
      }

      return json({ ok: false, error: { code: "NOT_FOUND" }, requestId: REQUEST_ID }, 404);
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    close: async () => {
      await server.stop(true);
    },
  };
}
