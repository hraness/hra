import { cronJobs, makeFunctionReference } from "convex/server";

const crons = cronJobs();
const drainAccountDeletion = makeFunctionReference<
  "mutation",
  Readonly<{ limit: number }>,
  unknown
>("accountDeletion:drain");
const drainDeviceRevocation = makeFunctionReference<
  "mutation",
  Readonly<{ limit: number }>,
  unknown
>("deviceRevocation:drain");
const drainAttentionNotifications = makeFunctionReference<
  "action",
  Readonly<{ limit: number }>,
  unknown
>("attentionNotificationDelivery:drain");
const cleanupExpired = makeFunctionReference<
  "mutation",
  Readonly<{ limit: number }>,
  Readonly<{
    authAttempts: number;
    bindChallenges: number;
    deviceCommandLoginResults: number;
    expiredPendingCommands: number;
    idempotencyReceipts: number;
    otpChallenges: number;
    processed: number;
    securityEvents: number;
    terminalCommands: number;
  }>
>("maintenance:cleanupExpired");

crons.interval("bounded cloud retention", { minutes: 15 }, cleanupExpired, { limit: 200 });
crons.interval("account deletion drain", { minutes: 1 }, drainAccountDeletion, { limit: 200 });
crons.interval("device revocation drain", { minutes: 1 }, drainDeviceRevocation, { limit: 200 });
crons.interval(
  "attention notification delivery",
  { minutes: 1 },
  drainAttentionNotifications,
  { limit: 10 },
);

export default crons;
