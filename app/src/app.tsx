import { ConvexAuthProvider, useConvexAuth } from "@convex-dev/auth/react";

import { convexClient } from "./auth/convex-client";
import { memoryTokenStorage } from "./auth/memory-token-storage";
import { SignInScreen } from "./auth/sign-in-screen";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card";
import { ErrorBoundary } from "./components/error-boundary";
import { CustodyProvider, useCustody } from "./custody/custody-context";
import { EnrollmentScreen } from "./custody/enrollment-screen";
import { LockScreen } from "./custody/lock-screen";
import { SessionsScreen } from "./screens/sessions-screen";

function Centered({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center p-4">
      {children}
    </main>
  );
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
          <SessionsScreen />
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
