import { expect, test } from "bun:test";

import {
  leaseDevelopmentRoot,
  type DevelopmentRoot,
  type DevelopmentRootLease,
} from "./root-lease";

test("accepted development entry revisions reuse one React root", () => {
  const lease: DevelopmentRootLease = {};
  let creations = 0;
  const create = (): DevelopmentRoot => {
    creations += 1;
    return { render: () => undefined };
  };

  const first = leaseDevelopmentRoot(lease, create);
  const next = leaseDevelopmentRoot(lease, create);

  expect(next).toBe(first);
  expect(creations).toBe(1);
});
