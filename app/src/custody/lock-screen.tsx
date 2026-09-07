import { useAuthActions } from "@convex-dev/auth/react";
import * as stylex from "@stylexjs/stylex";

import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { useCustody } from "./custody-context";
import { lockStyles } from "./lock-screen.stylex";

/**
 * The locked state. The account key is not in memory, so nothing is decryptable
 * until the reader unlocks: the tab re-reads the wrapped envelope and unwraps it
 * with the device wrapping key that never left the browser.
 */
export function LockScreen() {
  const custody = useCustody();
  const { signOut } = useAuthActions();

  return (
    <main {...stylex.props(lockStyles.root)}>
      <Card>
        <CardHeader>
          <CardTitle>Locked</CardTitle>
          <CardDescription>
            The account key is not held in this tab. Unlock to read and steer your sessions.
          </CardDescription>
        </CardHeader>
        <CardContent xstyle={lockStyles.cardContent}>
          {custody.error === null ? null : (
            <p {...stylex.props(lockStyles.error)} role="alert">{custody.error}</p>
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
