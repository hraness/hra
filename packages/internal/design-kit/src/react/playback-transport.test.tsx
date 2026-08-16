import { expect, test } from "bun:test";
import { Children, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ToggleButton } from "./button";
import {
  PlaybackTransport,
  type PlaybackTransportStatus,
} from "./playback-transport";

const statuses = ["idle", "pending", "playing"] as const satisfies
  readonly PlaybackTransportStatus[];

function renderTransport(status: PlaybackTransportStatus): string {
  return renderToStaticMarkup(
    <PlaybackTransport
      aria-label="Preview controls"
      onPlay={() => undefined}
      onStop={() => undefined}
      status={status}
    />,
  );
}

function semanticButtons(markup: string): readonly string[] {
  return [...markup.matchAll(/<button\b[^>]*>/gu)].map((match) => match[0]);
}

function jellyHosts(markup: string): readonly string[] {
  return [...markup.matchAll(/<jelly-card\b[^>]*>/gu)].map((match) => match[0]);
}

test("playback transport renders one stable icon command through every lifecycle state", () => {
  for (const status of statuses) {
    const html = renderTransport(status);
    const buttons = semanticButtons(html);
    const host = jellyHosts(html)[0] ?? "";

    expect(html).toContain('role="toolbar"');
    expect(html).toContain('aria-label="Preview controls"');
    expect(html).toContain(`data-playback-status="${status}"`);
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toContain('class="jungle-icon-button__control"');
    expect(host).toContain("jungle-playback-transport__button");
    expect(host).toContain('data-size="large"');
    expect(html).not.toContain("jungle-button__label");
  }

  const idle = renderTransport("idle");
  const pending = renderTransport("pending");
  const playing = renderTransport("playing");
  const idleControl = semanticButtons(idle)[0] ?? "";
  const pendingControl = semanticButtons(pending)[0] ?? "";
  const playingControl = semanticButtons(playing)[0] ?? "";

  expect(idleControl).toContain('aria-label="Play"');
  expect(idleControl).toContain('data-playback-command="play"');
  expect(idleControl).not.toContain('disabled=""');
  expect(idleControl).not.toContain('aria-busy="true"');
  expect(pendingControl).toContain('aria-label="Cancel playback start"');
  expect(pendingControl).toContain('data-playback-command="stop"');
  expect(pendingControl).toContain('aria-busy="true"');
  expect(pendingControl).not.toContain('disabled=""');
  expect(pending).toContain("jungle-spinner");
  expect(playingControl).toContain('aria-label="Stop"');
  expect(playingControl).toContain('data-playback-command="stop"');
  expect(playingControl).not.toContain('aria-busy="true"');
  expect(playingControl).not.toContain('disabled=""');
});

test("the combined command starts idle playback and stops pending or active playback", () => {
  let playCount = 0;
  let stopCount = 0;

  for (const status of statuses) {
    const transport = PlaybackTransport({
      "aria-label": "Preview controls",
      onPlay: () => {
        playCount += 1;
      },
      onStop: () => {
        stopCount += 1;
      },
      status,
    });
    if (!isValidElement<{ readonly children?: ReactNode }>(transport)) {
      throw new Error("PlaybackTransport did not return its toolbar element.");
    }
    const command = Children.toArray(transport.props.children)[0];
    if (!isValidElement<{ readonly onPress?: () => void }>(command)) {
      throw new Error("PlaybackTransport did not return its combined command first.");
    }
    command.props.onPress?.();
  }

  expect(playCount).toBe(1);
  expect(stopCount).toBe(2);
});

test("only an unavailable idle Play command is natively disabled", () => {
  const idle = renderToStaticMarkup(
    <PlaybackTransport
      aria-label="Preview controls"
      isPlayDisabled
      onPlay={() => undefined}
      onStop={() => undefined}
      status="idle"
    />,
  );
  const pending = renderToStaticMarkup(
    <PlaybackTransport
      aria-label="Preview controls"
      isPlayDisabled
      onPlay={() => undefined}
      onStop={() => undefined}
      status="pending"
    />,
  );

  expect(semanticButtons(idle)[0]).toContain('disabled=""');
  expect(semanticButtons(pending)[0]).not.toContain('disabled=""');
});

test("the optional trailing slot follows the single lifecycle command", () => {
  const html = renderToStaticMarkup(
    <PlaybackTransport
      aria-label="Loop preview"
      onPlay={() => undefined}
      onStop={() => undefined}
      status="idle"
      trailingControls={<ToggleButton isSelected>Loop</ToggleButton>}
    />,
  );

  const commandIndex = html.indexOf('data-playback-command="play"');
  const loopIndex = html.indexOf(">Loop</button>");

  expect(commandIndex).toBeGreaterThan(-1);
  expect(loopIndex).toBeGreaterThan(commandIndex);
  expect(html).toContain('aria-pressed="true"');
});

test("the transport owns its larger icon-control geometry and wrapping policy", async () => {
  const components = await Bun.file(
    new URL("../components.css", import.meta.url),
  ).text();
  const jelly = await Bun.file(new URL("../jelly.css", import.meta.url)).text();

  expect(components.match(
    /\.jungle-playback-transport\s*\{(?<body>[^}]*)\}/u,
  )?.groups?.body).toContain("flex-wrap: wrap;");
  expect(components.match(
    /\.jungle-icon-button\.jungle-playback-transport__button\s*\{(?<body>[^}]*)\}/u,
  )?.groups?.body).toContain("var(--control-height-transport, 4rem)");
  expect(jelly.match(
    /jelly-card\.jungle-icon-button\.jungle-playback-transport__button\s*\{(?<body>[^}]*)\}/u,
  )?.groups?.body).toContain("var(--control-height-transport, 4rem)");
});

test("the transport owns presentation states but no product playback machinery", async () => {
  const source = await Bun.file(
    new URL("./playback-transport.tsx", import.meta.url),
  ).text();

  for (const productConcern of [
    "AudioContext",
    "requestMIDIAccess",
    "setInterval",
    "setTimeout",
    "requestAnimationFrame",
  ]) {
    expect(source).not.toContain(productConcern);
  }
});
