import { desktopPairingIdSchema } from "@hraness/agent-tasks-protocol";
import { notFound } from "next/navigation";

import {
  AuthConfigurationUnavailable,
  convexAuthIsConfigured,
} from "../../../auth-configuration-state";
import { DesktopPairingApproval } from "./pairing-approval";

export default async function DesktopPairingPage({
  params,
}: {
  params: Promise<{ pairingId: string }>;
}) {
  const { pairingId } = await params;
  if (!desktopPairingIdSchema.safeParse(pairingId).success) notFound();
  if (!convexAuthIsConfigured()) return <AuthConfigurationUnavailable />;
  return <DesktopPairingApproval pairingId={pairingId} />;
}
