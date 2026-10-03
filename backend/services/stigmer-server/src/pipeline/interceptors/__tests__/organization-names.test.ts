/**
 * Pins the organization-name resolver (interceptors/organization-names.ts)
 * over a router transport whose handlers record what reaches them:
 *
 *   - every organization a request names by slug reaches the handler as
 *     its id: `metadata.org`, a reference's `org` nested in a spec, a
 *     top-level `org`, the Organization service's own annotated id, and a
 *     policy ref whose kind is organization;
 *   - an id, an empty value, a name nothing holds and a policy ref of
 *     another kind pass untouched, and a request that needs nothing is
 *     handed on as it came;
 *   - each distinct name is looked up once, and the caller's message is
 *     never mutated;
 *   - the field rule reads the contract's spelling (`org`, `*_org`,
 *     `orgs`) and the annotation, and is safe on recursive message types.
 */
import { create } from "@bufbuild/protobuf";
import type { Message } from "@bufbuild/protobuf";
import { createClient, createRouterTransport } from "@connectrpc/connect";
import type { Interceptor } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

import { AgentSchema } from "@stigmer/protos/ai/stigmer/agentic/agent/v1/api_pb";
import { AgentCommandController } from "@stigmer/protos/ai/stigmer/agentic/agent/v1/command_pb";
import { IamPolicyCommandController } from "@stigmer/protos/ai/stigmer/iam/iampolicy/v1/command_pb";
import { IamPolicySchema } from "@stigmer/protos/ai/stigmer/iam/iampolicy/v1/api_pb";
import { SearchService } from "@stigmer/protos/ai/stigmer/search/v1/query_pb";
import { OrganizationSchema } from "@stigmer/protos/ai/stigmer/tenancy/organization/v1/api_pb";
import { OrganizationCommandController } from "@stigmer/protos/ai/stigmer/tenancy/organization/v1/command_pb";
import { OrganizationQueryController } from "@stigmer/protos/ai/stigmer/tenancy/organization/v1/query_pb";
import { ApiResourceReferenceSchema } from "@stigmer/protos/ai/stigmer/commons/apiresource/io_pb";
import { CursorAccountSchema } from "@stigmer/protos/ai/stigmer/platform/cursoraccount/v1/cursor_account_pb";

import {
  annotatedOrganizationPath,
  createOrganizationNameInterceptor,
  isOrganizationId,
  namesOrganization,
  organizationFieldsOf,
} from "../organization-names.js";
import type { OrganizationNameResolver } from "../organization-names.js";

const ACME = "org_01jaaaaaaaaaaaaaaaaaaaaaaa";
const GLOBEX = "org_01jbbbbbbbbbbbbbbbbbbbbbbb";

/** A resolver over a fixed table, counting its lookups. */
function resolverOf(table: Record<string, string>): OrganizationNameResolver & {
  lookups: string[];
} {
  const lookups: string[] = [];
  return {
    lookups,
    resolve: async (name) => {
      lookups.push(name);
      return table[name];
    },
  };
}

function harness(resolver: OrganizationNameResolver) {
  const seen: Message[] = [];
  const passedOn: Message[] = [];
  const recordPassedOn: Interceptor = (next) => (request) => {
    if (!request.stream) {
      passedOn.push(request.message);
    }
    return next(request);
  };
  const transport = createRouterTransport(
    (router) => {
      router.service(AgentCommandController, {
        create: (request) => {
          seen.push(request);
          return create(AgentSchema, request);
        },
      });
      router.service(SearchService, {
        search: (request) => {
          seen.push(request);
          return {};
        },
      });
      router.service(OrganizationQueryController, {
        get: (request) => {
          seen.push(request);
          return create(OrganizationSchema);
        },
      });
      router.service(IamPolicyCommandController, {
        bootstrapPolicy: (request) => {
          seen.push(request);
          return create(IamPolicySchema);
        },
      });
    },
    {
      transport: {
        interceptors: [
          createOrganizationNameInterceptor(resolver),
          recordPassedOn,
        ],
      },
    },
  );
  return {
    seen,
    passedOn,
    agents: createClient(AgentCommandController, transport),
    search: createClient(SearchService, transport),
    organizations: createClient(OrganizationQueryController, transport),
    policies: createClient(IamPolicyCommandController, transport),
  };
}

describe("the organization-name resolver", () => {
  it("turns every organization a resource names by slug into its id, nested references included", async () => {
    const resolver = resolverOf({ acme: ACME, globex: GLOBEX });
    const { agents, seen } = harness(resolver);
    const input = create(AgentSchema, {
      metadata: { org: "acme", slug: "helper" },
      spec: {
        skillRefs: [
          create(ApiResourceReferenceSchema, { org: "globex", slug: "search" }),
          create(ApiResourceReferenceSchema, { org: "acme", slug: "write" }),
          create(ApiResourceReferenceSchema, { org: "", slug: "same-org" }),
        ],
      },
    });

    await agents.create(input);

    const agent = seen[0] as typeof input;
    expect(agent.metadata?.org).toBe(ACME);
    expect(agent.spec?.skillRefs.map((ref) => ref.org)).toEqual([
      GLOBEX,
      ACME,
      "",
    ]);
    expect(resolver.lookups.sort(), "each distinct name once").toEqual([
      "acme",
      "globex",
    ]);
    expect(input.metadata?.org, "the caller's message is untouched").toBe("acme");
  });

  it("resolves a top-level org, the Organization service's annotated id, and a policy ref of kind organization", async () => {
    const resolver = resolverOf({ acme: ACME });
    const { search, organizations, policies, seen } = harness(resolver);

    await search.search({ org: "acme" });
    await organizations.get({ value: "acme" });
    await policies.bootstrapPolicy({
      principal: { kind: "identity_account", id: "acme" },
      resource: { kind: "organization", id: "acme" },
      relation: "member",
    });

    expect((seen[0] as unknown as { org: string }).org).toBe(ACME);
    expect((seen[1] as unknown as { value: string }).value).toBe(ACME);
    const policy = seen[2] as unknown as {
      principal?: { id: string };
      resource?: { id: string };
    };
    expect(policy.resource?.id).toBe(ACME);
    expect(
      policy.principal?.id,
      "a ref of another kind is not an organization",
    ).toBe("acme");
  });

  it("passes ids, empty values and names nothing holds through untouched, handing on the request as it came", async () => {
    const resolver = resolverOf({});
    const { agents, search, passedOn } = harness(resolver);
    const byId = create(AgentSchema, { metadata: { org: ACME, slug: "a" } });
    const unknown = { org: "nobody-holds-this" };

    await agents.create(byId);
    await search.search(unknown);
    await search.search({ org: "" });

    expect((passedOn[0] as typeof byId).metadata?.org).toBe(ACME);
    expect((passedOn[1] as unknown as { org: string }).org).toBe("nobody-holds-this");
    expect(resolver.lookups, "an id and an empty value need no lookup").toEqual([
      "nobody-holds-this",
    ]);
  });
});

describe("the field rule, from the contract", () => {
  it("names organization fields by the spelling rule only", () => {
    const fields = (schema: { fields: Parameters<typeof namesOrganization>[0][] }) =>
      schema.fields.filter(namesOrganization).map((f) => f.name);
    expect(fields(ApiResourceReferenceSchema)).toEqual(["org"]);
    expect(fields(CursorAccountSchema)).toContain("orgs");
  });

  it("lists an input's organization fields at any depth, and the annotation of the Organization service", () => {
    expect(organizationFieldsOf(AgentSchema)).toEqual(
      expect.arrayContaining(["metadata.org", "spec.skill_refs.org"]),
    );
    expect(organizationFieldsOf(OrganizationSchema)).toContain("metadata.org");
    expect(annotatedOrganizationPath(OrganizationQueryController.method.get)).toBe(
      "value",
    );
    expect(annotatedOrganizationPath(OrganizationCommandController.method.rename)).toBe(
      "resource_id",
    );
    expect(annotatedOrganizationPath(AgentCommandController.method.create)).toBe(
      "metadata.org",
    );
    expect(annotatedOrganizationPath(SearchService.method.search)).toBeUndefined();
  });

  it("tells a minted id from a slug", () => {
    expect(isOrganizationId(ACME)).toBe(true);
    expect(isOrganizationId("acme")).toBe(false);
    expect(isOrganizationId("org-acme")).toBe(false);
    expect(isOrganizationId("org_ACME")).toBe(false);
  });
});
