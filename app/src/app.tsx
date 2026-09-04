import { ConvexAuthProvider, useConvexAuth } from "@convex-dev/auth/react";
import { useState } from "react";

import { convexClient } from "./auth/convex-client";
import { memoryTokenStorage } from "./auth/memory-token-storage";
import { SignInScreen } from "./auth/sign-in-screen";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card";
import { ErrorBoundary } from "./components/error-boundary";
import { CustodyProvider, useCustody } from "./custody/custody-context";
import { EnrollmentScreen } from "./custody/enrollment-screen";
import { LockScreen } from "./custody/lock-screen";
import { navigateBack, useRoute } from "./routing/router";
import { GridScreen } from "./screens/grid-screen";
import { SessionScreen } from "./screens/session-screen";
import { SettingsScreen } from "./screens/settings-screen";

function Centered({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center p-4">
      {children}
    </main>
  );
}

/**
 * The routed screens.
 *
 * The selected session is held here rather than in the grid, so it survives the
 * grid unmounting when a session opens: the grid composer targets the session
 * the reader last opened, and falls back to the most recently active one.
 */
function RoutedScreens() {
  const route = useRoute();
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  switch (route.kind) {
    case "session":
      return <SessionScreen key={route.sessionPublicId} sessionPublicId={route.sessionPublicId} />;
    case "settings":
      return <SettingsScreen onBack={navigateBack} />;
    case "grid":
      return (
        <GridScreen onSelect={setSelectedSessionId} selectedSessionId={selectedSessionId} />
      );
  }
}

function CustodyGate() {
  const custody = useCustody();
  switch (custody.state) {
    case "unlocked":
      return (
        <ErrorBoundary
          fallback={(error, reset) => (
            <Centered>
              <Card>
                <CardHeader>
                  <CardTitle>Something failed</CardTitle>
                  <CardDescription>{error.message}</CardDescription>
                </CardHeader>
                <CardContent>
                  <Button onClick={reset} variant="secondary">Try again</Button>
                </CardContent>
              </Card>
            </Centered>
          )}
          onError={custody.reportAuthorityFailure}
        >
          <RoutedScreens />
        </ErrorBoundary>
      );
    case "locked":
      return <LockScreen />;
    case "unenrolled":
    default:
      return <EnrollmentScreen />;
  }
}

function AuthGate() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  if (isLoading) {
    return (
      <Centered>
        <p className="text-sm text-ink-muted">Checking your session.</p>
      </Centered>
    );
  }
  if (!isAuthenticated) return <SignInScreen />;
  return (
    <CustodyProvider>
      <CustodyGate />
    </CustodyProvider>
  );
}

/**
 * Authentication tokens live in `memoryTokenStorage`, never in `localStorage`.
 * A reload asks for a new one-time code and a closed tab leaves no refresh token
 * behind (HRA v2 F5).
 */
export function App() {
  return (
    <ConvexAuthProvider client={convexClient} storage={memoryTokenStorage}>
      <AuthGate />
    </ConvexAuthProvider>
  );
}
