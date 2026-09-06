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
  // Never render a stale authorization code, including on the server-time tick
  // that reaches its exact deadline. The owning row also drops it from memory.
  if (expiresAt <= now) return null;

  return (
    <div className="space-y-1 text-xs text-ink-muted">
      <p>Enter this one-time code after signing in:</p>
      <code className="block font-mono text-ink">{userCode}</code>
      <p>
        <a className="underline" href={loginUrl} rel="noreferrer noopener" target="_blank">
          Open the provider login (single use, expires shortly)
        </a>
      </p>
    </div>
  );
}
