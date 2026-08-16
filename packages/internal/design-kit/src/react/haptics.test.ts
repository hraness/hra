import { expect, test } from "bun:test";
import type { HapticInput } from "web-haptics";

import {
  createHapticFeedbackController,
  HAPTIC_FEEDBACK_EVENT_NAME,
  hapticInputForFeedback,
  type HapticFeedbackEventDetail,
  type HapticModule,
  isHapticBrowserEnvironment,
  triggerHapticFeedback,
} from "./haptics";

class TestHapticEngine {
  static instances: TestHapticEngine[] = [];

  readonly triggers: HapticInput[] = [];
  readonly lifecycle: string[] = [];
  cancelCalls = 0;
  destroyCalls = 0;

  constructor() {
    TestHapticEngine.instances.push(this);
  }

  cancel(): void {
    this.cancelCalls += 1;
    this.lifecycle.push("cancel");
  }

  destroy(): void {
    this.destroyCalls += 1;
    this.lifecycle.push("destroy");
  }

  trigger(input: HapticInput = "selection"): Promise<void> {
    this.triggers.push(input);
    return Promise.resolve();
  }
}

const browserEnvironment = { document: {}, navigator: {}, window: {} } as const;
const testModule = { WebHaptics: TestHapticEngine } satisfies HapticModule;

class RejectingHapticEngine extends TestHapticEngine {
  override trigger(): Promise<void> {
    return Promise.reject(new Error("feedback backend rejected the trigger"));
  }
}

test("haptics remain inert in server and partial browser environments", async () => {
  expect(isHapticBrowserEnvironment({})).toBeFalse();
  expect(isHapticBrowserEnvironment(browserEnvironment)).toBeTrue();
  expect(await triggerHapticFeedback("press")).toBeFalse();
});

test("semantic haptics use the library's short official presets", () => {
  expect(hapticInputForFeedback("selection")).toBe("selection");
  expect(hapticInputForFeedback("press")).toBe("medium");
  expect(hapticInputForFeedback("success")).toBe("success");
  expect(hapticInputForFeedback("warning")).toBe("warning");
  expect(hapticInputForFeedback("error")).toBe("error");
});

test("only completed browser triggers publish the observational success event", async () => {
  TestHapticEngine.instances = [];
  const eventTarget = new EventTarget();
  const observedDetails: unknown[] = [];
  eventTarget.addEventListener(HAPTIC_FEEDBACK_EVENT_NAME, (event) => {
    if ("detail" in event) observedDetails.push(event.detail);
  });
  const eventEnvironment = {
    document: eventTarget,
    navigator: {},
    window: { CustomEvent },
  } as const;
  const controller = createHapticFeedbackController(
    eventEnvironment,
    () => Promise.resolve(testModule),
  );
  const expectedDetail = {
    feedback: "press",
    input: "medium",
  } satisfies HapticFeedbackEventDetail;

  expect(observedDetails).toEqual([]);
  expect(await controller.trigger("press")).toBeTrue();
  expect(observedDetails).toEqual([expectedDetail]);

  const rejectingController = createHapticFeedbackController(
    eventEnvironment,
    () => Promise.resolve({ WebHaptics: RejectingHapticEngine }),
  );
  expect(await rejectingController.trigger("warning")).toBeFalse();
  expect(observedDetails).toEqual([expectedDetail]);
});

test("the browser path triggers, cancels, and cancels again before disposal", async () => {
  TestHapticEngine.instances = [];
  const controller = createHapticFeedbackController(
    browserEnvironment,
    () => Promise.resolve(testModule),
  );

  expect(await controller.prepare()).toBeTrue();
  expect(await controller.trigger("success")).toBeTrue();
  expect(controller.cancel()).toBeTrue();
  controller.dispose();

  const instance = TestHapticEngine.instances[0];
  expect(instance).toBeDefined();
  expect(instance?.triggers).toEqual(["success"]);
  expect(instance?.cancelCalls).toBe(2);
  expect(instance?.destroyCalls).toBe(1);
  expect(instance?.lifecycle).toEqual(["cancel", "cancel", "destroy"]);
  expect(controller.cancel()).toBeFalse();
});

test("disposing during load cancels and destroys the late engine without leaking globals", async () => {
  TestHapticEngine.instances = [];
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let resolveModule: ((module: HapticModule) => void) | undefined;
  const pendingModule = new Promise<HapticModule>((resolve) => {
    resolveModule = resolve;
  });
  const controller = createHapticFeedbackController(
    browserEnvironment,
    async () => await pendingModule,
  );

  const preparation = controller.prepare();
  controller.dispose();
  resolveModule?.(testModule);

  expect(await preparation).toBeFalse();
  const instance = TestHapticEngine.instances[0];
  expect(instance?.cancelCalls).toBe(1);
  expect(instance?.destroyCalls).toBe(1);
  expect(instance?.lifecycle).toEqual(["cancel", "destroy"]);
  expect(Object.getOwnPropertyDescriptor(globalThis, "window")).toEqual(originalWindow);
  expect(Object.getOwnPropertyDescriptor(globalThis, "document")).toEqual(originalDocument);
  expect(Object.getOwnPropertyDescriptor(globalThis, "navigator")).toEqual(originalNavigator);
});
