/**
 * The organization settings sections hand the active organization to their
 * panel as `org`, and show a prompt instead when none is selected; the
 * profile section reselects an organization its panel updated by the
 * organization's id, which a rename leaves unchanged. The
 * organization context and the panels are stubbed: each panel only records
 * the organization it was given.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  activeId: "" as string,
  given: [] as Array<{ panel: string; org: string }>,
  onUpdated: undefined as ((org: { metadata: { id: string; slug: string } }) => void) | undefined,
  refreshed: [] as Array<string | undefined>,
}));

vi.mock("../../organization/OrgProvider.js", () => ({
  useOrg: () => ({
    activeOrg: state.activeId === "" ? undefined : { metadata: { id: state.activeId, slug: state.activeId } },
    refresh: (target?: string) => {
      state.refreshed.push(target);
    },
  }),
}));

function recordingPanel(panel: string) {
  return ({ org, onUpdated }: { org: string; onUpdated?: typeof state.onUpdated }) => {
    state.given.push({ panel, org });
    state.onUpdated = onUpdated;
    return null;
  };
}

vi.mock("../../organization/OrgPreferencesPanel.js", () => ({ OrgPreferencesPanel: recordingPanel("preferences") }));
vi.mock("../../organization/OrgProfilePanel.js", () => ({ OrgProfilePanel: recordingPanel("profile") }));
vi.mock("../../usage/OrgUsagePanel.js", () => ({ OrgUsagePanel: recordingPanel("usage") }));

import { OrgPreferencesSection } from "../OrgPreferencesSection";
import { OrgProfileSection } from "../OrgProfileSection";
import { UsageSection } from "../UsageSection";

afterEach(() => {
  cleanup();
  state.activeId = "";
  state.given = [];
  state.onUpdated = undefined;
  state.refreshed = [];
});

describe("the organization settings sections", () => {
  it.each([
    ["preferences", OrgPreferencesSection],
    ["profile", OrgProfileSection],
    ["usage", UsageSection],
  ] as const)("%s hands the active organization to its panel as org", (panel, Section) => {
    state.activeId = "acme";
    render(<Section />);
    expect(state.given).toEqual([{ panel, org: "acme" }]);
  });

  it.each([
    ["preferences", OrgPreferencesSection, /select an organization to view its preferences/i],
    ["profile", OrgProfileSection, /select an organization to view its profile/i],
  ] as const)("%s prompts for an organization when none is selected", (_panel, Section, prompt) => {
    render(<Section />);
    expect(screen.getByText(prompt)).toBeTruthy();
    expect(state.given).toEqual([]);
  });

  it("profile reselects an updated organization by its id, not its new slug", () => {
    state.activeId = "org_01jaaaaaaaaaaaaaaaaaaaaaaa";
    render(<OrgProfileSection />);
    state.onUpdated?.({ metadata: { id: "org_01jaaaaaaaaaaaaaaaaaaaaaaa", slug: "acme-labs" } });
    expect(state.refreshed).toEqual(["org_01jaaaaaaaaaaaaaaaaaaaaaaa"]);
  });
});
