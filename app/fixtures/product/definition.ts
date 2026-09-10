import { defineDirect, type JsonValue } from "@hraness/direct";
import { createDirectSession } from "@hraness/direct/testing";
import { createProductObservations, PRODUCT_PREVIEW_NOW } from "./fixtures";

export const PRODUCT_PREVIEW_VIEWS = ["overview", "conversation", "question", "settings"] as const;
export type ProductPreviewView = typeof PRODUCT_PREVIEW_VIEWS[number];
type ProductWorld = { readonly [key: string]: JsonValue; readonly version: 1; readonly view: ProductPreviewView };

export function parseProductPreviewWorld(input: unknown): ProductWorld {
  if (typeof input !== "object" || input === null || Array.isArray(input)
    || Object.getPrototypeOf(input) !== Object.prototype) throw new Error("Expected a product example.");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(descriptors).length !== 2 || !descriptors.version || !descriptors.view
    || !Object.values(descriptors).every((entry) => "value" in entry && entry.enumerable)) {
    throw new Error("The product example has unexpected fields.");
  }
  const version: unknown = descriptors.version.value;
  const view: unknown = descriptors.view.value;
  if (version !== 1 || typeof view !== "string" || !(PRODUCT_PREVIEW_VIEWS as readonly string[]).includes(view)) {
    throw new Error("Unknown product example.");
  }
  return Object.freeze({ version: 1, view: view as ProductPreviewView });
}

/** A public view selector is not a general Direct query/world override surface. */
export function parseProductPreviewSelection(query: string): ProductPreviewView {
  if (query.length > 2_048) throw new Error("The product example selector is too long.");
  const parameters = new URLSearchParams(query);
  if ([...parameters.keys()].length !== 1 || parameters.getAll("view").length !== 1) {
    throw new Error("Choose exactly one supported product example.");
  }
  return parseProductPreviewWorld({ version: 1, view: parameters.get("view") }).view;
}

export const productPreviewDefinition = defineDirect({
  parseWorld: parseProductPreviewWorld,
  defaultScenario: "product.overview",
  scenarios: PRODUCT_PREVIEW_VIEWS.map((view) => ({
    id: `product.${view}`, title: `Oompa ${view}`, route: "/" as const,
    world: { version: 1, view } satisfies ProductWorld,
    runtime: { schema: "direct.runtime/v1" as const, nowMs: PRODUCT_PREVIEW_NOW, nextOperation: 1, acceleration: 1 },
  })),
  coverage: [{
    key: "product.real-app-screens", mode: "fixture",
    claim: "The actual Oompa grid, conversation, closed-choice question, and settings screens render fictional observations through production reducers and components. These inert examples prove rendering only. Provider commands, authentication, credentials, storage, file reads, and live network IO are refused. They do not prove a connected account, accepted decisions, saved changes, or hosted activation.",
    scenarios: ["product.overview", "product.conversation", "product.question", "product.settings"],
  }],
});

export function createProductPreviewSession(view: ProductPreviewView) {
  return createDirectSession({
    definition: productPreviewDefinition,
    activation: { kind: "scenario", scenario: `product.${view}` },
    create: (context) => {
      let blockedFetches = 0;
      let browserActivityErrors = 0;
      let refusedEffects = 0;
      return Object.freeze({
        view: context.world.view,
        observations: createProductObservations(context.clock.now()),
        now: () => context.clock.now(),
        assertOpen: () => { if (context.signal.aborted) throw new Error("This product example is closed."); },
        refuse: (): never => {
          refusedEffects += 1;
          throw new Error("This is an inert product example. No command was sent and nothing was saved.");
        },
        blockedFetches: () => blockedFetches,
        recordBlockedFetch: () => { blockedFetches += 1; },
        browserActivityErrors: () => browserActivityErrors,
        recordBrowserActivityError: () => { browserActivityErrors += 1; },
        refusedEffects: () => refusedEffects,
      });
    },
    observe: (harness) => ({ violations: [
      { name: "example.blockedFetch", read: harness.blockedFetches },
      { name: "example.browserActivityError", read: harness.browserActivityErrors },
      { name: "example.refusedEffect", read: harness.refusedEffects },
    ] }),
  });
}

export type ProductPreviewSession = Extract<ReturnType<typeof createProductPreviewSession>, { ok: true }>["value"];
export type ProductPreviewHarness = ProductPreviewSession["harness"];
