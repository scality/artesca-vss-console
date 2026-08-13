// @vitest-environment jsdom
//
// The reveal path, exercised. The route has its own unit tests and a source scan
// keeps the password out of the server payload — but neither clicks the button,
// and until something does, "masked by default with an explicit reveal" is a
// claim about code nobody has run (ISVD-550).
//
// Rendered with react-dom/client + act rather than a testing library, matching
// topology-spinner-timeout.test.tsx — this repo has jsdom and no RTL.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";
import { GrafanaAccessCard } from "@/components/overview/GrafanaAccessCard";

const PASSWORD = "grafana-pw-not-in-the-payload";

describe("GrafanaAccessCard", () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  function render(props: Partial<React.ComponentProps<typeof GrafanaAccessCard>> = {}) {
    act(() => {
      root.render(
        <GrafanaAccessCard
          url="https://cluster.example:8443/"
          user="admin"
          hasPassword
          loginHint="sign in with the ARTESCA admin"
          {...props}
        />
      );
    });
  }

  function clickReveal() {
    const btn = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Reveal")
    );
    expect(btn, "reveal button should be present").toBeTruthy();
    return act(async () => {
      btn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  it("is masked before anything is clicked, and has fetched nothing", () => {
    render();
    expect(container.textContent).toContain("••••••••");
    expect(container.textContent).not.toContain(PASSWORD);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reveals the value on request, over POST", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ password: PASSWORD }),
    });
    render();
    await clickReveal();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/grafana-credential");
    expect((init as RequestInit).method).toBe("POST");
    expect(container.textContent).toContain(PASSWORD);
  });

  it("hides it again without a second request", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ password: PASSWORD }) });
    render();
    await clickReveal();
    expect(container.textContent).toContain(PASSWORD);

    const hide = [...container.querySelectorAll("button")].find(
      (b) => b.getAttribute("aria-label") === "Hide password"
    );
    expect(hide).toBeTruthy();
    await act(async () => {
      hide!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).not.toContain(PASSWORD);
    expect(container.textContent).toContain("••••••••");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // Kiosk mode answers 403. The card must say so rather than showing an empty
  // value, which would read as "there is no password".
  it("surfaces a refusal and shows no value", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: "kiosk mode is read-only" }),
    });
    render();
    await clickReveal();

    expect(container.textContent).toContain("kiosk mode is read-only");
    expect(container.textContent).not.toContain(PASSWORD);
  });

  // The case the early `return` in reveal() exists for, and the one a plain
  // "shows the error" test cannot see: a refusal whose body happens to carry a
  // password. Without the return, the handler falls through and displays it —
  // showing a credential the server just declined to give. Found by mutation:
  // deleting that return left every other test in this file green.
  it("does not display a password that arrives with an error status", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: "kiosk mode is read-only", password: PASSWORD }),
    });
    render();
    await clickReveal();

    expect(container.textContent).toContain("kiosk mode is read-only");
    expect(container.textContent).not.toContain(PASSWORD);
    expect(container.textContent).toContain("••••••••");
  });

  it("survives a network failure without claiming there is no password", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    render();
    await clickReveal();

    expect(container.textContent).toContain("Could not reach the console API");
    expect(container.textContent).not.toContain(PASSWORD);
  });

  it("offers no reveal at all when none is configured", () => {
    render({ hasPassword: false });
    expect(container.textContent).not.toContain("••••••••");
    expect(
      [...container.querySelectorAll("button")].some((b) => b.textContent?.includes("Reveal"))
    ).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("tells the operator the reveal is recorded", () => {
    render();
    expect(container.textContent).toContain("recorded in the audit log");
  });
});
