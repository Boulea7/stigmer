// Pins that every target names the organization it provisions by its minted
// id, as every resource does, never by its slug: the tenancy a suite writes
// under and the privileged scope an operator-lane arm runs in. The cloud
// target also deletes its tenancy's organization by that id at cleanup, and
// its privileged scope's at the scope's own cleanup. The organization
// service is stubbed; nothing here starts a server.
import { describe, expect, it, vi } from "vitest";

import type { ConformanceClients } from "../../harness/clients";
import { CloudTarget } from "../cloud";
import { LocalTarget } from "../local";
import { LocalExecutionTarget } from "../local-execution";
import type { PrivilegedScope } from "../target";

const ORG_ID = "org_01jaaaaaaaaaaaaaaaaaaaaaaa";

/** Clients whose organization create mints ORG_ID under a slug of its own, recording every delete. */
function organizationClients(): { clients: ConformanceClients; deleted: unknown[] } {
  const deleted: unknown[] = [];
  const clients = {
    organizationCommand: {
      create: async () => ({ metadata: { slug: "conformance-acme", id: ORG_ID } }),
      delete: async (input: unknown) => (deleted.push(input), {}),
    },
  } as unknown as ConformanceClients;
  return { clients, deleted };
}

describe.each([
  ["local", () => new LocalTarget()],
  ["local-execution", () => new LocalExecutionTarget()],
] as const)("the %s target", (_name, make) => {
  it("names its tenancy and its privileged scope by the organization's id", async () => {
    const target = make();
    const { clients } = organizationClients();
    vi.spyOn(target, "clients").mockReturnValue(clients);

    expect(await target.provisionTenancy()).toEqual({ org: ORG_ID });
    const scope = await target.provisionPrivilegedScope();
    expect(scope.context).toEqual({ org: ORG_ID });
    expect(scope.clients).toBe(clients);
  });
});

describe("the cloud target", () => {
  it("names its tenancy by the organization's id and deletes that organization once at cleanup", async () => {
    const target = new CloudTarget();
    const { clients, deleted } = organizationClients();
    vi.spyOn(target, "clients").mockReturnValue(clients);

    const tenancy = await target.provisionTenancy();
    expect(tenancy).toEqual({ org: ORG_ID });

    await target.cleanupTenancy(tenancy);
    await target.cleanupTenancy(tenancy);
    expect(deleted).toEqual([{ value: ORG_ID }]);
  });

  it("names the operator's privileged scope by its organization's id and deletes it at the scope's cleanup", async () => {
    const target = new CloudTarget();
    // setup() builds the operator's clients from a provisioned cloud's
    // operator credential; the test plants stubs in their place.
    const { clients, deleted } = organizationClients();
    const planted = target as unknown as {
      operatorClients: ConformanceClients;
      createPrivilegedScope(): Promise<PrivilegedScope>;
    };
    planted.operatorClients = clients;

    const scope = await planted.createPrivilegedScope();
    expect(scope.context).toEqual({ org: ORG_ID });
    expect(scope.clients).toBe(clients);

    await scope.cleanup();
    expect(deleted).toEqual([{ value: ORG_ID }]);
  });
});
