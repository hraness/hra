import { describe, expect, test } from "bun:test";

import type { PreparedAttachment } from "../domain/attachments.ts";
import { codexTurnInput } from "./client.ts";

/*
 * The pinned Codex 0.153.2 app-server accepts these `UserInput` variants on
 * `turn/start` and `turn/steer` (regenerated with
 * `codex app-server generate-ts --experimental`, `v2/UserInput.ts`):
 *
 *   text | image | localImage | audio | localAudio | skill | mention
 *
 * There is no file or document item, which is why a text-ish attachment is
 * folded into the text item instead of becoming its own content item.
 */

const image: PreparedAttachment = {
  base64: "aGVsbG8=",
  byteLength: 16,
  digest: "a".repeat(64),
  kind: "image",
  mediaType: "image/png",
  name: "diagram.png",
  path: "/state/attachments/aaaa.png",
};

const text: PreparedAttachment = {
  byteLength: 7,
  digest: "b".repeat(64),
  kind: "text",
  mediaType: "text/markdown",
  name: "notes.md",
  path: "/state/attachments/bbbb.txt",
  text: "# hello",
};

describe("codexTurnInput", () => {
  test("is the exact single text item HRA sent before attachments existed", () => {
    expect(codexTurnInput("run the tests")).toEqual([
      { type: "text", text: "run the tests" },
    ]);
    expect(JSON.stringify(codexTurnInput("run the tests")))
      .toBe(`[{"type":"text","text":"run the tests"}]`);
  });

  test("emits one localImage item per image, after the text item", () => {
    const items = codexTurnInput("what changed?", [image]);
    expect(items).toEqual([
      { type: "text", text: "what changed?" },
      { type: "localImage", path: "/state/attachments/aaaa.png" },
    ]);
  });

  test("folds a text-ish attachment into the text item with a header", () => {
    const items = codexTurnInput("review this", [text]);
    expect(items).toHaveLength(1);
    const first = items[0];
    expect(first?.type).toBe("text");
    const body = String(first?.text);
    expect(body.startsWith("review this\n\nAttached file: notes.md (text/markdown, 7 bytes)"))
      .toBe(true);
    expect(body).toContain("# hello");
  });

  test("carries both kinds together and never a blob's bytes", () => {
    const items = codexTurnInput("look", [image, text]);
    expect(items).toHaveLength(2);
    expect(JSON.stringify(items)).not.toContain("aGVsbG8=");
    expect(items[1]).toEqual({ type: "localImage", path: image.path });
  });

  test("refuses an attachment path that is not absolute and normalized", () => {
    expect(() => codexTurnInput("look", [{ ...image, path: "attachments/a.png" }]))
      .toThrow("attachment path must be absolute");
    expect(() => codexTurnInput("look", [{ ...image, path: "/state/../state/a.png" }]))
      .toThrow("attachment path must already be normalized");
  });
});
