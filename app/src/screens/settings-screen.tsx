import type { ReactNode } from "react";

import { BackIcon } from "../components/icons";
import { Button } from "../components/ui/button";
import { navigateBack } from "../routing/router";

/**
 * The settings placeholder.
 *
 * The route, the header, and the back path ship here so the grid's settings
 * control is reachable; the contents (archived sessions, autorespond, the
 * gateway key, show-thinking, machines, accounts, devices, sign out) are the
 * second half of round two.
 */
export function SettingsScreen(): ReactNode {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col pt-[env(safe-area-inset-top)]">
      <header className="flex items-center gap-2 border-b border-line px-[max(0.5rem,env(safe-area-inset-left))] py-2">
        <Button aria-label="Back to the grid" onClick={navigateBack} size="icon" variant="ghost">
          <BackIcon />
        </Button>
        <h1 className="text-sm font-semibold">Settings</h1>
      </header>
      <main className="flex-1 px-[max(1rem,env(safe-area-inset-left))] py-4">
        <p className="text-sm text-ink-muted">Settings arrive next.</p>
      </main>
    </div>
  );
}
