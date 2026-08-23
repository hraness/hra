import { hasExactKeys, isRecord } from "./contracts";

export type AuthSignInResult =
  | Readonly<{ kind: "code_requested_or_rejected" }>
  | Readonly<{
      kind: "authenticated";
      refreshToken: string;
      token: string;
    }>;

function isBoundedToken(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 32
    && value.length <= 16_384
    && !/\s/u.test(value);
}

export function parseAuthSignInResult(value: unknown): AuthSignInResult | null {
  if (!isRecord(value) || !hasExactKeys(value, ["tokens"])) return null;
  if (value.tokens === null) return { kind: "code_requested_or_rejected" };
  if (
    !isRecord(value.tokens)
    || !hasExactKeys(value.tokens, ["refreshToken", "token"])
    || !isBoundedToken(value.tokens.refreshToken)
    || !isBoundedToken(value.tokens.token)
  ) return null;
  return {
    kind: "authenticated",
    refreshToken: value.tokens.refreshToken,
    token: value.tokens.token,
  };
}
