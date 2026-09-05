/** Exact externally installed Devin CLI release, never a range or prerelease. */
export type DevinPinVersion = `${number}.${number}.${number}`;

export const DEVIN_PIN = "3000.6.14" satisfies DevinPinVersion;

/** Exact model family HRA asks the pinned Devin ACP server to use. */
export const DEVIN_MODEL = "gpt-6-astra";

/** Naming-compatible alias for other pinned provider modules. */
export const DEVIN_PIN_MODEL = DEVIN_MODEL;

/** Stable ACP protocol version implemented by the installed SDK entry point. */
export const DEVIN_ACP_PROTOCOL_VERSION = 1;
