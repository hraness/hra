import {
  runtimeChatDomainCommandSchema,
  type RuntimeDispatchRequest,
} from "../../contracts/runtime";

export type HostRequestLane = "independent" | "serialized";

export function runtimeDispatchHostRequestLane(
  request: RuntimeDispatchRequest,
): HostRequestLane {
  return request.command.type === "observation.attention.list" ||
      runtimeChatDomainCommandSchema.safeParse(request.command).success
    ? "independent"
    : "serialized";
}

/**
 * Serializes mutation-shaped host work while keeping reviewed independent
 * reads and per-pane chat admission out of the product-wide mutation tail.
 */
export class HostRequestLaneScheduler {
  #serializedTail: Promise<void> = Promise.resolve();

  run(lane: HostRequestLane, task: () => Promise<void>): Promise<void> {
    if (lane === "independent") return task();
    const response = this.#serializedTail.then(task);
    this.#serializedTail = response.catch(() => undefined);
    return response;
  }
}
