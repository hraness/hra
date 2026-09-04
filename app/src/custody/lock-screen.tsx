import { useAuthActions } from "@convex-dev/auth/react";

import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { useCustody } from "./custody-context";

/**
 * The locked state. The account key is not in memory, so nothing is decryptable
 * until the reader unlocks: the tab re-reads the wrapped envelope and unwraps it
 * with the device wrapping key that never left the browser.
 */
export function LockScreen() {
  const custody = useCustody();
  const { signOut } = useAuthActions();

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center p-4">
      <Card>
        <CardHeader>
          <CardTitle>Locked</CardTitle>
          <CardDescription>
            The account key is not held in this tab. Unlock to read and steer your sessions.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {custody.error === null ? null : (
            <p className="text-sm text-danger" role="alert">{custody.error}</p>
          )}
          <Button disabled={custody.busy} onClick={() => { void custody.unlock(); }}>
            Unlock
          </Button>
          <Button onClick={() => { void signOut(); }} variant="ghost">Sign out</Button>
        </CardContent>
      </Card>
    </main>
  );
}
