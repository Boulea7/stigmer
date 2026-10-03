// Unit tests for the organization-name helpers the commands that compare or
// print organizations use (client/organizations.ts): equal strings need no
// call, an id and a slug of one organization are the same, a value the
// caller cannot see is a different organization and prints as given.

import { create } from "@bufbuild/protobuf";
import type { Stigmer } from "@stigmer/sdk";
import { OrganizationSchema } from "@stigmer/protos/ai/stigmer/tenancy/organization/v1/api_pb";
import { describe, expect, it } from "vitest";
import { organizationLabel, organizationNamed, sameOrganization } from "../organizations.js";

const ACME_ID = "org_01jaaaaaaaaaaaaaaaaaaaaaaa";

/** A client whose organization get answers acme by slug or id, and fails for anything else. */
function stigmerKnowingAcme(): Stigmer & { gets: string[] } {
  const gets: string[] = [];
  return {
    gets,
    organization: {
      get: async (value: string) => {
        gets.push(value);
        if (value !== "acme" && value !== ACME_ID) throw new Error("not found");
        return create(OrganizationSchema, { metadata: { id: ACME_ID, slug: "acme" } });
      },
    },
  } as unknown as Stigmer & { gets: string[] };
}

describe("organization names", () => {
  it("answers the organization a slug or id names, and undefined for one the caller cannot see", async () => {
    const stigmer = stigmerKnowingAcme();
    expect(await organizationNamed(stigmer, "acme")).toEqual({ id: ACME_ID, slug: "acme" });
    expect(await organizationNamed(stigmer, ACME_ID)).toEqual({ id: ACME_ID, slug: "acme" });
    expect(await organizationNamed(stigmer, "globex")).toBeUndefined();
    expect(await organizationNamed(stigmer, "")).toBeUndefined();
  });

  it("treats a slug and an id of one organization as the same, without a call for equal strings", async () => {
    const stigmer = stigmerKnowingAcme();
    expect(await sameOrganization(stigmer, "acme", "acme")).toBe(true);
    expect(stigmer.gets).toEqual([]);
    expect(await sameOrganization(stigmer, "acme", ACME_ID)).toBe(true);
    expect(await sameOrganization(stigmer, "acme", "globex")).toBe(false);
  });

  it("labels an organization by its slug, or by the value as given when the caller cannot see it", async () => {
    const stigmer = stigmerKnowingAcme();
    expect(await organizationLabel(stigmer, ACME_ID)).toBe("acme");
    expect(await organizationLabel(stigmer, "org_01jbbbbbbbbbbbbbbbbbbbbbbb")).toBe(
      "org_01jbbbbbbbbbbbbbbbbbbbbbbb",
    );
  });
});
