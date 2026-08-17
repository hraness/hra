import {
  createReducerStore,
  type ReducerStore,
  type StoreListener,
} from "@hra-internal/codex-app-sdk";

import type { CodexFact } from "../codex";
import { createSessionState, type SessionState } from "./model";
import {
  acceptedSessionFacts,
  purgeSessionAccount,
  reduceSessionFact,
  reduceSessionFacts,
} from "./reducer";

export type SessionStoreListener = StoreListener;

/**
 * A small React-compatible external store around the pure session fold.
 * Dispatch is synchronous and each batch publishes at most one revision.
 */
export class SessionStore {
  readonly #store: ReducerStore<SessionState, SessionState>;

  constructor(initial: SessionState = createSessionState()) {
    this.#store = createReducerStore(
      initial,
      (_current, next) => next,
    );
  }

  getSnapshot = (): SessionState => this.#store.getSnapshot();

  subscribe = (listener: SessionStoreListener): (() => void) =>
    this.#store.subscribe(listener);

  dispatch(fact: CodexFact): SessionState {
    return this.#install(reduceSessionFact(this.getSnapshot(), fact));
  }

  dispatchBatch(facts: readonly CodexFact[]): SessionState {
    return this.#install(reduceSessionFacts(this.getSnapshot(), facts));
  }

  dispatchAcceptedBatch(facts: readonly CodexFact[]): Readonly<{
    accepted: readonly CodexFact[];
    snapshot: SessionState;
  }> {
    const accepted = acceptedSessionFacts(this.getSnapshot(), facts);
    return {
      accepted,
      snapshot: this.#install(reduceSessionFacts(this.getSnapshot(), accepted)),
    };
  }

  purgeAccount(accountProfileId: string): SessionState {
    return this.#install(
      purgeSessionAccount(this.getSnapshot(), accountProfileId),
    );
  }

  #install(next: SessionState): SessionState {
    return this.#store.dispatch(next).snapshot;
  }
}
