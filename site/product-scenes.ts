export const productScenes = {
  overview: { label: "Session grid", description: "Follow several sessions at once. Each card keeps its state, recent work, and next action together.", guide: "/docs/web/" },
  conversation: { label: "Conversation", description: "Read a session’s conversation and recent activity, then compose the next turn in the same workspace.", guide: "/docs/sessions/" },
  question: { label: "Needs your input", description: "A closed-choice question makes the next decision visible. Protected approvals still belong on the session’s machine.", guide: "/docs/web/" },
  settings: { label: "Accounts & devices", description: "See your paired machines and their registered accounts. Linking a Codex account requires permission on that machine.", guide: "/docs/web/" },
} as const;

export type ProductScene = keyof typeof productScenes;
export const productPreviewDisclosure = "Real Oompa interface, fictional sessions and accounts. These examples cannot sign in, send a request, or change a machine.";

export const isProductScene = (value: unknown): value is ProductScene =>
  typeof value === "string" && Object.hasOwn(productScenes, value);

function previewEnvelope(value: unknown): Readonly<{ type: unknown; view: ProductScene }> | undefined {
  if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(fields).length !== 2 || fields.type === undefined || fields.view === undefined
    || !Object.values(fields).every((field) => "value" in field && field.enumerable)) return undefined;
  const type: unknown = fields.type.value;
  const view: unknown = fields.view.value;
  return isProductScene(view) ? { type, view } : undefined;
}

export type PreviewStatusMessage = Readonly<{ type: "oompa-preview-ready" | "oompa-preview-failed"; view: ProductScene }>;

export function parsePreviewMessage(value: unknown): PreviewStatusMessage | undefined {
  const envelope = previewEnvelope(value);
  return envelope !== undefined && (envelope.type === "oompa-preview-ready" || envelope.type === "oompa-preview-failed")
    ? { type: envelope.type, view: envelope.view } : undefined;
}

export function parsePreviewStatusRequest(value: unknown): Readonly<{ type: "oompa-preview-status"; view: ProductScene }> | undefined {
  const envelope = previewEnvelope(value);
  return envelope?.type === "oompa-preview-status" ? { type: envelope.type, view: envelope.view } : undefined;
}

/** A late parent can request the same public observation without restarting
 * the child. No request changes the scene, clears failure or starts any work. */
export function createPreviewStatusRelay(view: ProductScene, send: (message: PreviewStatusMessage) => void) {
  let status: PreviewStatusMessage | undefined;
  return {
    publish(type: PreviewStatusMessage["type"]): void {
      if (status?.type === "oompa-preview-failed") return;
      status = { type, view };
      send(status);
    },
    replay(request: unknown): void {
      if (status !== undefined && parsePreviewStatusRequest(request)?.view === view) send(status);
    },
  };
}
