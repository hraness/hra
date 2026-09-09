import { AppearanceHeader } from "../components/appearance";
import { useAuthActions } from "@convex-dev/auth/react";
import * as stylex from "@stylexjs/stylex";
import { useRef, useState } from "react";

import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { otpProviderId } from "../env";
import { signInStyles } from "./sign-in-screen.stylex";

type Stage = "email" | "code";

/**
 * The hosted one-time-code sign-in, mirroring the CLI credential shape in
 * `src/cloud/local-control.ts`: the send step posts exactly `{ email }` and the
 * verify step posts exactly `{ email, code }`. The provider rejects any other
 * key set, so nothing extra may be added here.
 */
export function SignInScreen() {
  const { signIn } = useAuthActions();
  const [stage, setStage] = useState<Stage>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const requestPending = useRef(false);
  const [error, setError] = useState<string | null>(null);

  const canonicalEmail = email.trim().toLowerCase();

  const submit = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    // Own the request before React paints disabled controls. Two same-render
    // submits must not send competing codes or verify the same code twice.
    if (requestPending.current) return;
    requestPending.current = true;
    setBusy(true);
    setError(null);
    const params = stage === "email"
      ? { email: canonicalEmail }
      : { code: code.trim(), email: canonicalEmail };
    void signIn(otpProviderId, params)
      .then(() => {
        if (stage === "email") setStage("code");
      })
      .catch(() => {
        setError(stage === "email"
          ? "That address could not be used to request a code."
          : "That code was not accepted. Request a new one.");
      })
      .finally(() => {
        requestPending.current = false;
        setBusy(false);
      });
  };

  return (
    <main {...stylex.props(signInStyles.root)}>
      <AppearanceHeader />
      <Card>
        <CardHeader>
          <CardTitle>Sign in to HRA</CardTitle>
          <CardDescription>
            {stage === "email"
              ? "Enter your email address and we will send a one-time code."
              : `Enter the eight-digit code sent to ${canonicalEmail}.`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form {...stylex.props(signInStyles.form)} onSubmit={submit}>
            {stage === "email" ? (
              <Input
                aria-label="Email address"
                autoCapitalize="none"
                autoComplete="email"
                autoCorrect="off"
                disabled={busy}
                inputMode="email"
                name="email"
                onChange={(event) => { setEmail(event.target.value); }}
                placeholder="you@example.com"
                required
                type="email"
                value={email}
              />
            ) : (
              <Input
                aria-label="One-time code"
                autoComplete="one-time-code"
                disabled={busy}
                inputMode="numeric"
                maxLength={8}
                name="code"
                onChange={(event) => { setCode(event.target.value); }}
                pattern="[0-9]{8}"
                placeholder="12345678"
                required
                value={code}
              />
            )}
            {error === null ? null : (
              <p {...stylex.props(signInStyles.error)} role="alert">{error}</p>
            )}
            <Button disabled={busy} type="submit">
              {stage === "email" ? "Send code" : "Verify code"}
            </Button>
            {stage === "code" ? (
              <Button
                disabled={busy}
                onClick={() => {
                  setStage("email");
                  setCode("");
                  setError(null);
                }}
                variant="ghost"
              >
                Use a different address
              </Button>
            ) : null}
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
