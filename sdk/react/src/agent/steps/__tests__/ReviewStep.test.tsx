/**
 * The agent wizard's review step names the organization the agent is created
 * in by its slug, which a person reads, while the manifest it previews (and
 * submits) names the org by its id.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ReviewStep } from "../ReviewStep";
import { createInitialWizardData } from "../types";
import { ACME_ID, orgWrapper } from "../../../organization/__tests__/org-fixture";

afterEach(cleanup);

const data = { ...createInitialWizardData(), name: "Triage", slug: "triage" };

describe("ReviewStep (agent)", () => {
  it("shows the organization's slug and previews a manifest naming its id", async () => {
    render(<ReviewStep org={ACME_ID} data={data} isCreating={false} error={null} />, {
      wrapper: orgWrapper(),
    });

    const orgValue = await screen.findByText("acme");
    expect(orgValue.previousElementSibling?.textContent).toBe("Organization");
    expect(screen.getByText(/org: org_01jaaaaaaaaaaaaaaaaaaaaaaa/)).toBeTruthy();
  });

  it("shows the reference unchanged for an organization the person is not in", () => {
    render(
      <ReviewStep org="org_01jzzzzzzzzzzzzzzzzzzzzzzz" data={data} isCreating={false} error={null} />,
    );

    const orgValue = screen
      .getAllByText("org_01jzzzzzzzzzzzzzzzzzzzzzzz")
      .find((el) => el.tagName === "DD");
    expect(orgValue?.previousElementSibling?.textContent).toBe("Organization");
  });
});
