import { afterEach, describe, expect, it, vi } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import "../test-helpers/load-styles.ts";
import { setupSidebarTest } from "../test-helpers/app-sidebar-setup.ts";
import {
  createGatewayHarness,
  createSessionsHarness,
  mountSidebar,
} from "../test-helpers/app-sidebar.ts";
import "./app-sidebar.ts";

setupSidebarTest();
afterEach(async () => {
  await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: false });
});

const key = "agent:main:dashboard:acba34fb-b9a1-4453-836a-f50251abd42e";

describe.runIf("__vitest_browser__" in globalThis)("pinned continuation navigation", () => {
  it.each([280, 220])(
    "keeps title and controls distinct at %i px with coarse pointer",
    async (width) => {
      await page.viewport(1440, 1000);
      await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
      expect(matchMedia("(pointer: coarse)").matches).toBe(true);
      const childKey = "agent:main:child-fixture";
      const harness = createSessionsHarness("main", [key, childKey]);
      Object.assign(harness.sessions.state.result!.sessions[0]!, {
        sessionId: "f8f2e402-35a8-4bbb-8cfe-6098668b1e9d",
        label: "C1 Continuation",
        displayName: "C1 Continuation",
        pinned: true,
        archived: false,
        boardFace: "dashboard",
        childSessions: [childKey],
      });
      Object.assign(harness.sessions.state.result!.sessions[1]!, { spawnedBy: key });
      const { provider, sidebar } = await mountSidebar(
        createGatewayHarness({ instanceId: "self-instance" } as GatewayBrowserClient).gateway,
        harness.sessions,
      );
      const shell = document.createElement("div");
      shell.className = "shell";
      shell.style.cssText = `display:block;width:${width}px`;
      provider.replaceWith(shell);
      shell.append(provider);
      sidebar.style.cssText = `display:block;width:${width}px;height:1000px`;
      sidebar.connected = true;
      const onNavigate = vi.fn((_routeId: string, _options?: { pathname?: string }) => {});
      sidebar.onNavigate = onNavigate;
      await sidebar.updateComplete;
      const row = sidebar.querySelector<HTMLElement>(`[data-session-key="${key}"]`)!;
      const link = row.querySelector<HTMLAnchorElement>(".sidebar-recent-session__link")!;
      const title = row.querySelector<HTMLElement>(".sidebar-recent-session__name")!;
      const a = link.getBoundingClientRect();
      const t = title.getBoundingClientRect();
      const hit = document.elementFromPoint(t.x + Math.min(t.width / 2, 20), t.y + t.height / 2);
      console.log(
        "PINNED_AFTER_GEOMETRY",
        JSON.stringify({
          width,
          row: row.getBoundingClientRect().toJSON(),
          link: a.toJSON(),
          title: t.toJSON(),
          hit: hit?.outerHTML.slice(0, 250),
          href: link.getAttribute("href"),
          zone: row.closest(".sidebar-zone-entry")?.outerHTML.slice(0, 160),
          count: sidebar.querySelectorAll(`[data-session-key="${key}"]`).length,
        }),
      );
      await page.screenshot({
        path: `../../.vitest/pinned-after-${width}.png`,
        animations: "disabled",
      });
      expect(t.width).toBeGreaterThan(100);
      expect(title.scrollWidth).toBeLessThanOrEqual(title.clientWidth);
      expect(link.getAttribute("href")).toContain("acba34fbb9a14453836af50251abd42e");
      expect(link.contains(hit)).toBe(true);
      const nav = page.getByRole("link", { name: /C1 Continuation/ });
      await nav.click();
      expect(onNavigate).toHaveBeenCalledTimes(1);
      expect(onNavigate.mock.calls[0]?.[0]).toBe("dashboard");
      expect(onNavigate.mock.calls[0]?.[1]?.pathname).toBe(link.getAttribute("href"));
      link.focus();
      expect(document.activeElement).toBe(link);
      await userEvent.keyboard("{Enter}");
      expect(onNavigate).toHaveBeenCalledTimes(2);
      onNavigate.mockClear();
      const controls = [
        row.querySelector<HTMLButtonElement>("[data-sidebar-session-pin]")!,
        row.querySelector<HTMLButtonElement>("[data-sidebar-session-archive]")!,
        row.querySelector<HTMLButtonElement>("[data-sidebar-session-menu]")!,
        row.querySelector<HTMLButtonElement>("[data-child-session-toggle]")!,
        row
          .closest(".sidebar-zone-entry")!
          .querySelector<HTMLButtonElement>(".sidebar-reorder-trigger")!,
      ];
      for (const control of controls) {
        const box = control.getBoundingClientRect();
        expect(box.width).toBeGreaterThan(0);
        expect(box.height).toBeGreaterThan(0);
        const linkBox = link.getBoundingClientRect();
        const overlapWidth = Math.min(linkBox.right, box.right) - Math.max(linkBox.left, box.left);
        const overlapHeight = Math.min(linkBox.bottom, box.bottom) - Math.max(linkBox.top, box.top);
        expect(overlapWidth <= 0.5 || overlapHeight <= 0.5).toBe(true);
        expect(
          control.contains(
            document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
          ),
        ).toBe(true);
      }
      const noop = vi.fn();
      (sidebar as typeof sidebar & { toggleSessionPin: typeof noop }).toggleSessionPin = noop;
      (sidebar as typeof sidebar & { toggleSessionChildren: typeof noop }).toggleSessionChildren =
        noop;
      (sidebar as typeof sidebar & { toggleSessionMenu: typeof noop }).toggleSessionMenu = noop;
      vi.spyOn(sidebar.sessionOrganizer, "archiveSessionWithUndo").mockImplementation(async () => {
        noop();
      });
      await page.elementLocator(controls[0]).click();
      await page.elementLocator(controls[1]).click();
      await page.elementLocator(controls[2]).click();
      await page.elementLocator(controls[3]).click();
      expect(noop).toHaveBeenCalledTimes(4);
      expect(onNavigate).not.toHaveBeenCalled();
      expect(harness.sessions.state.result!.sessions[0]!.pinned).toBe(true);
    },
  );
});
