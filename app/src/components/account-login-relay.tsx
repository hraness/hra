import { useState } from "react";

import { Button } from "./ui/button";

export type AccountLoginRelayProps = Readonly<{
  expiresAt: number;
  loginUrl: string;
  now: number;
  userCode: string;
}>;

/** The complete one-time handoff a person needs to finish provider device login. */
export function AccountLoginRelay({
  expiresAt,
  loginUrl,
  now,
  userCode,
}: AccountLoginRelayProps) {
  const [copyNotice, setCopyNotice] = useState<string | null>(null);

  const copyCode = () => {
    try {
      void navigator.clipboard.writeText(userCode)
        .then(() => { setCopyNotice("Code copied."); })
        .catch(() => { setCopyNotice("Copy is unavailable. Select the code above."); });
    } catch {
      // Some browsers expose the typed API but omit it at runtime outside a
      // secure context. The visible code remains the manual-copy fallback.
      setCopyNotice("Copy is unavailable. Select the code above.");
    }
  };

  // Never render a stale authorization code, including on the server-time tick
  // that reaches its exact deadline. The owning row also drops it from memory.
  if (expiresAt <= now) return null;

  return (
    <div className="space-y-1 text-xs text-ink-muted">
      <p>Enter this one-time code after signing in:</p>
      <div className="flex flex-wrap items-center gap-2">
        <code className="font-mono text-ink">{userCode}</code>
        <Button onClick={copyCode} size="small" variant="ghost">Copy code</Button>
      </div>
      {copyNotice === null ? null : <p role="status">{copyNotice}</p>}
      <p>
        <a className="underline" href={loginUrl} rel="noreferrer noopener" target="_blank">
          Open the provider login (single use, expires shortly)
        </a>
      </p>
    </div>
  );
}
