import * as stylex from "@stylexjs/stylex";

import { accountLoginRelayStyles } from "./account-login-relay.stylex";

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
    <div {...stylex.props(accountLoginRelayStyles.root)}>
      <p {...stylex.props(accountLoginRelayStyles.paragraph)}>Enter this one-time code after signing in:</p>
      <code {...stylex.props(accountLoginRelayStyles.code)}>{userCode}</code>
      <p {...stylex.props(accountLoginRelayStyles.paragraph)}>
        <a {...stylex.props(accountLoginRelayStyles.link)} href={loginUrl} rel="noreferrer noopener" target="_blank">
          Open Codex sign-in
        </a>
      </p>
      <p {...stylex.props(accountLoginRelayStyles.paragraph)}>Keep this HRA tab open until sign-in finishes. This code cannot be retrieved again.</p>
    </div>
  );
}
