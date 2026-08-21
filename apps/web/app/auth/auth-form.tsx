"use client";

import { desktopPairingIdSchema } from "@hraness/agent-tasks-protocol";
import { useAuthActions } from "@convex-dev/auth/react";
import { Button, InlineAlert, LinkButton, PageIntro, SettingsCard } from "@hra-internal/design-kit/react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useState, type FormEvent } from "react";

async function migrationClaimProof(claim: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`hra-password-migration-v1:${claim}`),
  );
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function safeReturnPath(value: string | null): string {
  if (value === "/app") return value;
  if (typeof value === "string") {
    const match = value.match(/^\/pair\/desktop\/([^/]+)$/u);
    if (match !== null && desktopPairingIdSchema.safeParse(match[1]).success) return value;
  }
  return "/app";
}

export function PasswordAuthForm({ mode }: { mode: "sign-in" | "sign-up" }) {
  const { signIn } = useAuthActions();
  const router = useRouter();
  const search = useSearchParams();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const values = new FormData(event.currentTarget);
    try {
      const rawMigrationClaim = String(values.get("migrationClaim") ?? "");
      const result = await signIn("password", {
        flow: mode === "sign-in" ? "signIn" : "signUp",
        email: String(values.get("email") ?? ""),
        password: String(values.get("password") ?? ""),
        ...(mode === "sign-up"
          ? {
              name: String(values.get("name") ?? ""),
              ...(rawMigrationClaim === ""
                ? {}
                : { migrationClaimProof: await migrationClaimProof(rawMigrationClaim) }),
            }
          : {}),
      });
      if (!result.signingIn) throw new Error("Sign-in did not complete.");
      router.replace(safeReturnPath(search.get("next")));
    } catch {
      setError(mode === "sign-in"
        ? "The email or password was not accepted."
        : "The account could not be created. Check the fields and try again.");
      setBusy(false);
    }
  }, [busy, mode, router, search, signIn]);

  return (
    <main className="state-page" id="main-content">
      <SettingsCard
        className="state-card"
        title={mode === "sign-in" ? "Sign in to HRA" : "Create your HRA account"}
      >
        <PageIntro
          eyebrow="Password authentication"
          title={mode === "sign-in" ? "Human control plane" : "Start with a personal workspace"}
          titleAs="h2"
        />
        <form className="auth-form" onSubmit={(event) => void submit(event)}>
          {mode === "sign-up" ? (
            <label>
              <span>Name</span>
              <input autoComplete="name" maxLength={240} name="name" required type="text" />
            </label>
          ) : null}
          <label>
            <span>Email</span>
            <input autoComplete="email" maxLength={320} name="email" required type="email" />
          </label>
          <label>
            <span>Password</span>
            <input
              autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
              minLength={12}
              maxLength={1024}
              name="password"
              required
              type="password"
            />
          </label>
          {mode === "sign-up" ? (
            <label>
              <span>Existing-account migration claim <small>optional</small></span>
              <input autoComplete="off" name="migrationClaim" type="password" />
            </label>
          ) : null}
          {error === null ? null : <InlineAlert tone="danger">{error}</InlineAlert>}
          <Button isDisabled={busy} isPending={busy} type="submit" variant="primary">
            {mode === "sign-in" ? "Sign in" : "Create account"}
          </Button>
        </form>
        <div className="button-row">
          <LinkButton href={mode === "sign-in" ? "/auth/sign-up" : "/auth/sign-in"} variant="quiet">
            {mode === "sign-in" ? "Create account" : "Use an existing account"}
          </LinkButton>
        </div>
      </SettingsCard>
    </main>
  );
}
