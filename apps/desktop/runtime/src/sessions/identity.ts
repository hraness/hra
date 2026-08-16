export function ownedCodexId(
  prefix: "item" | "thread" | "turn",
  accountProfileId: string,
  codexId: string,
): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(`${accountProfileId}\u0000${codexId}`);
  return `${prefix}_${hasher.digest("hex").slice(0, 24)}`;
}
