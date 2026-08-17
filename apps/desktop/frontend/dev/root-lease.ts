export interface DevelopmentRoot {
  render(children: unknown): void;
}

export interface DevelopmentRootLease {
  root?: DevelopmentRoot;
}

export function leaseDevelopmentRoot(
  lease: DevelopmentRootLease,
  create: () => DevelopmentRoot,
): DevelopmentRoot {
  const existing = lease.root;
  if (existing !== undefined) return existing;
  const root = create();
  lease.root = root;
  return root;
}
