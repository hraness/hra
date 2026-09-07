import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { TranscriptView } from "./transcript-view";

describe("TranscriptView", () => {
  test("renders an automated message as automation, not an autoresponse or the owner", () => {
    const markup = renderToStaticMarkup(
      <TranscriptView
        entries={[{
          actor: "automation",
          attachments: null,
          key: "automation-message",
          kind: "user",
          text: "Perform the scheduled check.",
        }]}
        thinkingText=""
      />,
    );

    expect(markup).toContain(">automation<");
    expect(markup).not.toContain(">autorespond<");
    expect(markup).not.toContain(">you<");
  });

  test("renders a provider-switch seed as a provider handoff", () => {
    const markup = renderToStaticMarkup(
      <TranscriptView
        entries={[{
          actor: "provider_switch",
          attachments: null,
          key: "handoff-seed",
          kind: "user",
          text: "Continue from the portable transcript.",
        }]}
        thinkingText=""
      />,
    );

    expect(markup).toContain("provider handoff");
    expect(markup).not.toContain(">you<");
  });

  test("renders a future bounded host actor as another sender, never as the owner", () => {
    const markup = renderToStaticMarkup(
      <TranscriptView
        entries={[{
          actor: "unknown",
          attachments: null,
          key: "future-host-actor",
          kind: "user",
          text: "Message from a future host actor.",
        }]}
        thinkingText=""
      />,
    );

    expect(markup).toContain("other sender");
    expect(markup).not.toContain(">you<");
  });
});
