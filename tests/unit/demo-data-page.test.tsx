// @vitest-environment jsdom
/**
 * Unit tests for the Demo Data page's disable-confirmation guard.
 *
 * The DemoDataPage itself is too heavy to render in vitest (useEffect fetches,
 * KioskProvider, Shell, Radix portals), so we extract the confirm-dialog
 * state machine into a minimal harness — exactly the same pattern used in
 * topology-spinner-timeout.test.tsx.
 *
 * What we verify:
 *  1. A disable request (OFF) opens the confirm dialog; no callback fires.
 *  2. Cancelling closes the dialog; the disable callback is NOT called.
 *  3. Confirming closes the dialog; the disable callback IS called.
 *  4. An enable request (ON) does NOT open the dialog; the enable callback fires immediately.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot } from "react-dom/client";
import React, { act, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";

// ── Minimal harness that mirrors the relevant slice of DemoDataPage ───────────

interface HarnessProps {
  initialEnabled: boolean;
  onEnable: () => void;
  onDisable: () => void;
}

function ConfirmDisableHarness({ initialEnabled, onEnable, onDisable }: HarnessProps) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [confirmOpen, setConfirmOpen] = useState(false);

  function handleSwitchChange(checked: boolean) {
    if (!checked) {
      setConfirmOpen(true);
    } else {
      setEnabled(true);
      onEnable();
    }
  }

  function handleConfirm() {
    setConfirmOpen(false);
    setEnabled(false);
    onDisable();
  }

  function handleCancel() {
    setConfirmOpen(false);
  }

  return (
    <div>
      <Switch
        id="enabled"
        checked={enabled}
        onCheckedChange={handleSwitchChange}
        data-testid="producer-switch"
      />
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disable demo data?</DialogTitle>
            <DialogDescription>
              The synthetic incident feed will stop.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={handleCancel}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleConfirm}>
              Disable
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── DOM helpers ───────────────────────────────────────────────────────────────

function getSwitch(container: HTMLElement): HTMLButtonElement | null {
  return container.querySelector('[role="switch"]');
}

function getDialog(): HTMLElement | null {
  return document.body.querySelector('[role="dialog"]');
}

function queryButton(root: Document | HTMLElement, label: RegExp): HTMLButtonElement | null {
  const buttons = Array.from(root.querySelectorAll("button")) as HTMLButtonElement[];
  return buttons.find((b) => label.test(b.textContent ?? "")) ?? null;
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("Demo Data — disable confirmation guard", () => {
  let container: HTMLDivElement;
  let domRoot: ReturnType<typeof createRoot>;
  let onEnable: () => void;
  let onDisable: () => void;

  // Typed as vi.Mock so we can call .toHaveBeenCalledOnce() — cast to () => void
  // in HarnessProps to satisfy the interface.
  let onEnableMock: ReturnType<typeof vi.fn>;
  let onDisableMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onEnableMock = vi.fn();
    onDisableMock = vi.fn();
    onEnable = onEnableMock as unknown as () => void;
    onDisable = onDisableMock as unknown as () => void;
    container = document.createElement("div");
    document.body.appendChild(container);
    domRoot = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      domRoot.unmount();
    });
    container.remove();
  });

  async function render(initialEnabled: boolean) {
    await act(async () => {
      domRoot.render(
        <ConfirmDisableHarness
          initialEnabled={initialEnabled}
          onEnable={onEnable}
          onDisable={onDisable}
        />
      );
    });
  }

  // ── 1. Switch OFF → dialog opens, no callback ─────────────────────────────

  it("clicking the switch OFF opens the confirm dialog without calling onDisable", async () => {
    await render(true);

    const sw = getSwitch(container);
    expect(sw).not.toBeNull();
    expect(sw!.getAttribute("aria-checked")).toBe("true");

    await act(async () => {
      sw!.click();
    });

    expect(getDialog()).not.toBeNull();
    expect(onDisableMock).not.toHaveBeenCalled();
    expect(onEnableMock).not.toHaveBeenCalled();
  });

  // ── 2. Cancel → dialog closes, no callback ───────────────────────────────

  it("Cancel closes the dialog and does not call onDisable", async () => {
    await render(true);

    await act(async () => {
      getSwitch(container)!.click();
    });
    expect(getDialog()).not.toBeNull();

    const cancelBtn = queryButton(document.body, /cancel/i);
    expect(cancelBtn).not.toBeNull();
    await act(async () => {
      cancelBtn!.click();
    });

    expect(getDialog()).toBeNull();
    expect(onDisableMock).not.toHaveBeenCalled();
  });

  // ── 3. Confirm (Disable) → dialog closes, onDisable called ───────────────

  it("Disable button closes the dialog and calls onDisable", async () => {
    await render(true);

    await act(async () => {
      getSwitch(container)!.click();
    });
    expect(getDialog()).not.toBeNull();

    const disableBtn = queryButton(document.body, /^disable$/i);
    expect(disableBtn).not.toBeNull();
    await act(async () => {
      disableBtn!.click();
    });

    expect(getDialog()).toBeNull();
    expect(onDisableMock).toHaveBeenCalledOnce();
    expect(onEnableMock).not.toHaveBeenCalled();
  });

  // ── 4. Switch ON → no dialog, onEnable called immediately ────────────────

  it("clicking the switch ON does NOT open a dialog and calls onEnable immediately", async () => {
    await render(false);

    const sw = getSwitch(container);
    expect(sw!.getAttribute("aria-checked")).toBe("false");

    await act(async () => {
      sw!.click();
    });

    expect(getDialog()).toBeNull();
    expect(onEnableMock).toHaveBeenCalledOnce();
    expect(onDisableMock).not.toHaveBeenCalled();
  });
});
