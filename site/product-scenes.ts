export const productScenes = {
  overview: { label: "Session grid", description: "Follow several sessions at once. Each card keeps its state, recent work, and next action together.", guide: "/docs/web/" },
  conversation: { label: "Conversation", description: "Read a session’s conversation and recent activity, then compose the next turn in the same workspace.", guide: "/docs/sessions/" },
  question: { label: "Needs your input", description: "A closed-choice question makes the next decision visible. Protected approvals still belong on the session’s machine.", guide: "/docs/web/" },
  settings: { label: "Accounts & devices", description: "See your paired machines and their registered accounts. Linking a Codex account requires permission on that machine.", guide: "/docs/web/" },
} as const;

export type ProductScene = keyof typeof productScenes;
export const productPreviewDisclosure = "Real HRA interface, fictional sessions and accounts. These examples cannot sign in, send a request, or change a machine.";

export const isProductScene = (value: unknown): value is ProductScene =>
  typeof value === "string" && Object.hasOwn(productScenes, value);

export function parsePreviewMessage(value: unknown): Readonly<{ type: "hra-preview-ready" | "hra-preview-failed"; view: ProductScene }> | undefined {
  if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(fields).length !== 2 || fields.type === undefined || fields.view === undefined
    || !Object.values(fields).every((field) => "value" in field && field.enumerable)) return undefined;
  const type: unknown = fields.type.value;
  const view: unknown = fields.view.value;
  return (type === "hra-preview-ready" || type === "hra-preview-failed") && isProductScene(view) ? { type, view } : undefined;
}
