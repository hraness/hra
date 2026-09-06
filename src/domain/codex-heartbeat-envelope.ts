export const PROTECTED_PROVIDER_TEXT_MARKER = "[protected]";

export const CODEX_DESKTOP_HEARTBEAT_ENVELOPE_PREFIX =
  "<heartbeat>\n  <automation_id>";

const CODEX_DESKTOP_HEARTBEAT_ROOT = "<heartbeat>";
const CODEX_DESKTOP_HEARTBEAT_TITLE_PREFIX = "<heartbeat>\n  <automation_id";
const codexDesktopHeartbeatEnvelope = /^<heartbeat>\n {2}<automation_id>([^\r\n]+)<\/automation_id>\n {2}<current_time_iso>(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)<\/current_time_iso>\n {2}<instructions>\n {2}[\s\S]*\n {2}<\/instructions>\n<\/heartbeat>$/u;

export const isExactCodexDesktopHeartbeatEnvelope = (input: string): boolean => {
  const match = codexDesktopHeartbeatEnvelope.exec(input);
  if (match === null) return false;
  const automationId = match[1];
  const currentTimeIso = match[2];
  if (automationId === undefined || automationId.trim() === "" || currentTimeIso === undefined) {
    return false;
  }
  const timestamp = Date.parse(currentTimeIso);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === currentTimeIso;
};

export const replaceCodexDesktopHeartbeatEnvelope = (input: string): string =>
  isExactCodexDesktopHeartbeatEnvelope(input)
    ? PROTECTED_PROVIDER_TEXT_MARKER
    : input;

export const replaceCodexDesktopHeartbeatTitle = (input: string): string =>
  input.length >= CODEX_DESKTOP_HEARTBEAT_ROOT.length
  && (
    CODEX_DESKTOP_HEARTBEAT_TITLE_PREFIX.startsWith(input)
    || input.startsWith(CODEX_DESKTOP_HEARTBEAT_TITLE_PREFIX)
  )
    ? PROTECTED_PROVIDER_TEXT_MARKER
    : input;
