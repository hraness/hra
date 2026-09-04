import { useAuthActions } from "@convex-dev/auth/react";

import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { useCustody } from "./custody-context";

function Fingerprint({ value }: Readonly<{ value: string }>) {
  return (
    <p className="mt-2 select-all break-all rounded-md bg-surface-input p-3 font-mono text-sm">
      {value}
    </p>
  );
}

/**
 * Browser device enrollment.
 *
 * A browser is never the first device on an account and never approves another
 * device: it registers, shows its public key fingerprint, and waits for a
 * machine with hra installed to approve it against that exact fingerprint.
 */
export function EnrollmentScreen() {
  const custody = useCustody();
  const { signOut } = useAuthActions();

  const body = () => {
    switch (custody.enrollment) {
      case "needs_first_device":
        return (
          <>
            <CardTitle>This account has no approved machine yet</CardTitle>
            <CardDescription>
              A browser is never the first device on an account. Install hra on the machine that
              runs your sessions, sign in there, and come back.
            </CardDescription>
          </>
        );
      case "needs_registration":
        return (
          <>
            <CardTitle>Enroll this browser</CardTitle>
            <CardDescription>
              This tab generates a signing key and a wrapping key that never leave the browser, then
              asks one of your machines to approve them.
            </CardDescription>
          </>
        );
      case "awaiting_approval":
        return (
          <>
            <CardTitle>Waiting for approval</CardTitle>
            <CardDescription>
              Approve this device from a machine with hra installed, and compare this fingerprint
              before you do.
            </CardDescription>
            {custody.fingerprint === null ? null : <Fingerprint value={custody.fingerprint} />}
            <CardDescription>
              Run <span className="font-mono">hra device list</span> and then{" "}
              <span className="font-mono">hra device approve</span> on that machine.
            </CardDescription>
          </>
        );
      case "revoked":
        return (
          <>
            <CardTitle>This device was revoked</CardTitle>
            <CardDescription>
              Its keys no longer open the account. Sign out, then enroll a new browser device.
            </CardDescription>
          </>
        );
      case "needs_bind":
      case "active":
      case "unknown":
      default:
        return (
          <>
            <CardTitle>Checking this device</CardTitle>
            <CardDescription>Reading the account and the device registration.</CardDescription>
          </>
        );
    }
  };

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center p-4">
      <Card>
        <CardHeader>{body()}</CardHeader>
        <CardContent className="flex flex-col gap-3">
          {custody.error === null ? null : (
            <p className="text-sm text-danger" role="alert">{custody.error}</p>
          )}
          {custody.enrollment === "needs_registration" ? (
            <Button disabled={custody.busy} onClick={() => { void custody.enroll(); }}>
              Enroll this browser
            </Button>
          ) : null}
          {custody.enrollment === "awaiting_approval" ? (
            <Button
              disabled={custody.busy}
              onClick={() => { void custody.refresh(); }}
              variant="secondary"
            >
              Check again
            </Button>
          ) : null}
          <Button onClick={() => { void signOut(); }} variant="ghost">Sign out</Button>
        </CardContent>
      </Card>
    </main>
  );
}
