import type { ReactNode } from "react";

import { AuthenticatedLayout } from "../authenticated-layout";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return <AuthenticatedLayout>{children}</AuthenticatedLayout>;
}
