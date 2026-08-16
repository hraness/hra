import { useCallback, useState } from "react";

import { NativeSelectField, SwitchField, ToggleButton } from "../../ui";

import type {
  HarnessAutomaticFastMode,
  HarnessRefinementMode,
} from "../../../../contracts/runtime";
import { type RuntimeShell, useRuntimeShellSelector } from "../../runtime";
import {
  harnessEqual,
  runtimeAvailabilityEqual,
  selectHarness,
  selectRuntimeAvailability,
  updateHarnessSettingsCommand,
} from "../chat/model";

const MIB = 1024 * 1024;
const contextQuotaOptions = Array.from({ length: 64 }, (_, index) => {
  const mib = index + 1;
  return { id: String(mib * MIB), label: `${String(mib)} MiB` };
});

function errorMessage(reason: unknown): string {
  return reason instanceof Error
    ? reason.message
    : "The local runtime did not complete the harness request.";
}

export function harnessSettingsMutationEnabled(
  availability: ReturnType<typeof selectRuntimeAvailability>,
): boolean {
  return availability.kind === "ready";
}

export function HarnessSettings({ shell }: { readonly shell: RuntimeShell }) {
  const harness = useRuntimeShellSelector(shell, selectHarness, harnessEqual);
  const availability = useRuntimeShellSelector(
    shell,
    selectRuntimeAvailability,
    runtimeAvailabilityEqual,
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runtimeReady = harnessSettingsMutationEnabled(availability);

  const updateSettings = useCallback(async (patch: Readonly<Partial<{
    recursiveSessionsEnabled: boolean;
    automaticFastMode: HarnessAutomaticFastMode;
    contextQuotaBytes: number;
    refinementMode: HarnessRefinementMode;
  }>>) => {
    if (harness === null || pending || !runtimeReady) return;
    setPending(true);
    setError(null);
    try {
      const response = await shell.dispatch(updateHarnessSettingsCommand({
        expectedHarnessRevision: harness.revision,
        expectedRevision: harness.settings.revision,
        recursiveSessionsEnabled: patch.recursiveSessionsEnabled ??
          harness.settings.recursiveSessionsEnabled,
        automaticFastMode: patch.automaticFastMode ??
          harness.settings.automaticFastMode,
        contextQuotaBytes: patch.contextQuotaBytes ??
          harness.settings.contextQuotaBytes,
        refinementMode: patch.refinementMode ?? harness.settings.refinementMode,
      }));
      if (!response.ok) throw new Error(response.error.message);
    } catch (reason: unknown) {
      setError(errorMessage(reason));
    } finally {
      setPending(false);
    }
  }, [harness, pending, runtimeReady, shell]);

  if (harness === null) return null;

  return (
    <section aria-labelledby="harness-title" className="settings-section harness-settings">
      <h1 id="harness-title">Harness</h1>
      <div className="harness-setting-row">
        <SwitchField
          className="harness-recursive"
          description="Allow Codex to delegate work to persistent child sessions."
          isDisabled={pending || !runtimeReady}
          isSelected={harness.settings.recursiveSessionsEnabled}
          label="Recursive sessions"
          onChange={(isSelected) => void updateSettings({
            recursiveSessionsEnabled: isSelected,
            ...(isSelected ? {} : { refinementMode: "off" as const }),
          })}
        />
        <NativeSelectField
          className="harness-quota"
          disabled={
            pending || !runtimeReady || !harness.settings.recursiveSessionsEnabled
          }
          label="Context quota"
          onChange={(value) => void updateSettings({ contextQuotaBytes: Number(value) })}
          options={contextQuotaOptions}
          showLabel={false}
          size="compact"
          surface="pane"
          value={String(harness.settings.contextQuotaBytes)}
        />
      </div>
      <div className="harness-refinement-row">
        <SwitchField
          description="Let HRA accelerate a critical-path recursive turn when faster inference can shorten the task. This never changes the manual Fast setting on ordinary panes."
          isDisabled={
            pending || !runtimeReady || !harness.settings.recursiveSessionsEnabled
          }
          isSelected={harness.settings.automaticFastMode === "criticalPath"}
          label="Automatic Fast for recursive sessions"
          onChange={(isSelected) => void updateSettings({
            automaticFastMode: isSelected ? "criticalPath" : "off",
          })}
        />
      </div>
      <div className="harness-refinement-row">
        <div className="subscription-identity">
          <strong>Refinement suggestions</strong>
          <span>
            Let recursive sessions save review-only improvement proposals. HRA
            never applies them automatically.
          </span>
        </div>
        <div aria-label="Refinement suggestions" className="harness-mode" role="group">
          {(["off", "suggest"] as const).map((mode) => (
            <ToggleButton
              controlClassName="harness-mode__option"
              isDisabled={
                pending ||
                !runtimeReady ||
                (mode === "suggest" && !harness.settings.recursiveSessionsEnabled)
              }
              isSelected={harness.settings.refinementMode === mode}
              key={mode}
              onPress={() => void updateSettings({ refinementMode: mode })}
              size="compact"
              variant="quiet"
            >
              {mode === "off" ? "Off" : "Suggest"}
            </ToggleButton>
          ))}
        </div>
      </div>

      {harness.proposals.length === 0 ? null : (
        <ul aria-label="Harness proposals" className="harness-proposal-list">
          {harness.proposals.map((proposal) => (
            <li key={proposal.id} title={proposal.title}>
              <span>{proposal.title}</span>
            </li>
          ))}
        </ul>
      )}
      {error === null ? null : <p className="settings-inline-error" role="alert">{error}</p>}
    </section>
  );
}
