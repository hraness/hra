export const FAKE_SCENARIOS = [
  "initialize",
  "stream",
  "server-request",
  "delay",
  "malformed",
  "chunked",
  "exit",
] as const;

export type FakeScenario = (typeof FAKE_SCENARIOS)[number];

export const FIXTURE_IDS = {
  thread: "0190f8c0-7a31-7e62-8000-000000000001",
  turn: "0190f8c0-7a31-7e62-8000-000000000002",
  item: "fake-agent-message-1",
  serverRequest: "fake-server-request-1",
  question: "direction",
} as const;

const ACTIVE_TURN = {
  id: FIXTURE_IDS.turn,
  items: [],
  itemsView: "full",
  status: "inProgress",
  error: null,
  startedAt: 1_700_000_000,
  completedAt: null,
  durationMs: null,
} as const;

const COMPLETED_MESSAGE = {
  type: "agentMessage",
  id: FIXTURE_IDS.item,
  text: "Ready 🌿",
  phase: "final_answer",
  memoryCitation: null,
} as const;

const COMPLETED_TURN = {
  ...ACTIVE_TURN,
  items: [COMPLETED_MESSAGE],
  status: "completed",
  completedAt: 1_700_000_001,
  durationMs: 1_000,
} as const;

export const INITIALIZE_RESULT = {
  userAgent: "oprte-fake-app-server/1.0.0",
  codexHome: "/fixture/codex-home",
  platformFamily: "unix",
  platformOs: "macos",
} as const;

export const STREAM_NOTIFICATIONS = [
  {
    method: "turn/started",
    params: {
      threadId: FIXTURE_IDS.thread,
      turn: ACTIVE_TURN,
    },
  },
  {
    method: "item/agentMessage/delta",
    params: {
      threadId: FIXTURE_IDS.thread,
      turnId: FIXTURE_IDS.turn,
      itemId: FIXTURE_IDS.item,
      delta: "Ready ",
    },
  },
  {
    method: "item/agentMessage/delta",
    params: {
      threadId: FIXTURE_IDS.thread,
      turnId: FIXTURE_IDS.turn,
      itemId: FIXTURE_IDS.item,
      delta: "🌿",
    },
  },
  {
    method: "item/completed",
    params: {
      threadId: FIXTURE_IDS.thread,
      turnId: FIXTURE_IDS.turn,
      item: COMPLETED_MESSAGE,
      completedAtMs: 1_700_000_001_000,
    },
  },
  {
    method: "turn/completed",
    params: {
      threadId: FIXTURE_IDS.thread,
      turn: COMPLETED_TURN,
    },
  },
] as const;

export const USER_INPUT_REQUEST = {
  id: FIXTURE_IDS.serverRequest,
  method: "item/tool/requestUserInput",
  params: {
    threadId: FIXTURE_IDS.thread,
    turnId: FIXTURE_IDS.turn,
    itemId: FIXTURE_IDS.item,
    questions: [
      {
        id: FIXTURE_IDS.question,
        header: "Direction",
        question: "Continue with the deterministic fixture?",
        isOther: false,
        isSecret: false,
        options: [
          {
            label: "Continue",
            description: "Resolve the fake request and continue the fixture.",
          },
          {
            label: "Stop",
            description: "Resolve the fake request without further work.",
          },
        ],
      },
    ],
    autoResolutionMs: 120_000,
  },
} as const;

export const MALFORMED_OUTPUT_LINE =
  '{"id":"fake-malformed","result":{"unterminated":true}';

export const CHUNKED_SENTINEL = "split-across-writes: A🌿B";
