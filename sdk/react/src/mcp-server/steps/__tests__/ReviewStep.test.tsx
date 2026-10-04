/**
 * The MCP server wizard's review step names the organization the server is
 * created in by its slug, which a person reads, while the manifest it
 * previews (and submits) names the org by its id.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ReviewStep } from "../ReviewStep";
import { createInitialMcpServerWizardData } from "../types";
import { ACME_ID, orgWrapper } from "../../../organization/__tests__/org-fixture";

afterEach(cleanup);

const data = {
  ...createInitialMcpServerWizardData(),
  name: "GitHub",
  slug: "github",
  httpUrl: "https://mcp.example.com",
};

describe("ReviewStep (MCP server)", () => {
  it("shows the organization's slug and previews a manifest naming its id", async () => {
    render(<ReviewStep org={ACME_ID} data={data} isCreating={false} error={null} />, {
      wrapper: orgWrapper(),
    });

    const orgValue = await screen.findByText("acme");
    expect(orgValue.previousElementSibling?.textContent).toBe("Organization");
    expect(screen.getByText(/org: org_01jaaaaaaaaaaaaaaaaaaaaaaa/)).toBeTruthy();
  });
});
