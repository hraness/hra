import type { ReactNode } from "react";

import { AuthenticatedLayout } from "../authenticated-layout";

export default function PairLayout({ children }: { children: ReactNode }) {
  return <AuthenticatedLayout>{children}</AuthenticatedLayout>;
}
