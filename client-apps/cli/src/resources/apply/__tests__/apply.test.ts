// Unit tests for the shared apply core's follow-ups through guarded doors.
// Plain updates preserve stored visibility (oss#573) and an organization's
// slug, so the apply RPC's response carries the STORED values; when a
// manifest declares a different level the core lands it through
// updateVisibility (or warns when the kind has no such door), and when an
// organization manifest carries its id and a different slug, through rename.
// And the org-mismatch warning: an organization is named by id or slug, so
// two different strings are asked about before they are called different.

import { create, type Message } from "@bufbuild/protobuf";
import { AgentSchema } from "@stigmer/protos/ai/stigmer/agentic/agent/v1/api_pb";
import { ApiResourceKind } from "@stigmer/protos/ai/stigmer/commons/apiresource/apiresourcekind/api_resource_kind_pb";
import { ApiResourceVisibility } from "@stigmer/protos/ai/stigmer/commons/apiresource/enum_pb";
import type { RenameInput, UpdateVisibilityInput } from "@stigmer/protos/ai/stigmer/commons/apiresource/io_pb";
import { OrganizationSchema } from "@stigmer/protos/ai/stigmer/tenancy/organization/v1/api_pb";
import { describe, expect, it } from "vitest";
import { applyMessage } from "../apply.js";
import type { ApplyHandler, ControllerFn } from "../handlers.js";

// The controller accessor is only ever forwarded to handler methods, which
// these tests stub out — a throwing dummy proves nothing else touches it.
const controller: ControllerFn = () => {
  throw new Error("unexpected controller access");
};

function agent(visibility: ApiResourceVisibility, id = "agent-1") {
  return create(AgentSchema, {
    metadata: { id, name: "a", org: "acme", visibility },
    spec: { instructions: "i" },
  });
}

interface HandlerOptions {
  applyReturns: Message;
  updateVisibility?: (input: UpdateVisibilityInput) => Promise<Message>;
}

function handlerWith(opts: HandlerOptions): { handler: ApplyHandler; calls: UpdateVisibilityInput[] } {
  const calls: UpdateVisibilityInput[] = [];
  const handler: ApplyHandler = {
    kind: ApiResourceKind.agent,
    displayName: "Agent",
    schema: AgentSchema,
    applyOrder: 3,
    apply: () => Promise.resolve(opts.applyReturns),
    ...(opts.updateVisibility !== undefined && {
      updateVisibility: (_c: ControllerFn, input: UpdateVisibilityInput) => {
        calls.push(input);
        return opts.updateVisibility!(input);
      },
    }),
  };
  return { handler, calls };
}

describe("applyMessage declared-visibility follow-up", () => {
  it("lands a declared level the update preserved away, and reflects it on the outcome", async () => {
    // Server preserved stored org; manifest declares platform.
    const { handler, calls } = handlerWith({
      applyReturns: agent(ApiResourceVisibility.visibility_org),
      updateVisibility: () => Promise.resolve(agent(ApiResourceVisibility.visibility_platform)),
    });

    const outcome = await applyMessage(controller, handler, agent(ApiResourceVisibility.visibility_platform), "acme", false);

    expect(calls).toHaveLength(1);
    expect(calls[0].resourceId).toBe("agent-1");
    expect(calls[0].visibility).toBe(ApiResourceVisibility.visibility_platform);
    expect(outcome.warning).toBeUndefined();
    const appliedMeta = (outcome.applied as { metadata?: { visibility?: ApiResourceVisibility } })?.metadata;
    expect(appliedMeta?.visibility).toBe(ApiResourceVisibility.visibility_platform);
  });

  it("skips the follow-up when the manifest omits visibility", async () => {
    const { handler, calls } = handlerWith({
      applyReturns: agent(ApiResourceVisibility.visibility_org),
      updateVisibility: () => Promise.reject(new Error("must not be called")),
    });

    const outcome = await applyMessage(
      controller,
      handler,
      agent(ApiResourceVisibility.api_resource_visibility_unspecified),
      "acme",
      false,
    );

    expect(calls).toHaveLength(0);
    expect(outcome.warning).toBeUndefined();
  });

  it("skips the follow-up when the server already matches (idempotent re-apply)", async () => {
    const { handler, calls } = handlerWith({
      applyReturns: agent(ApiResourceVisibility.visibility_platform),
      updateVisibility: () => Promise.reject(new Error("must not be called")),
    });

    const outcome = await applyMessage(controller, handler, agent(ApiResourceVisibility.visibility_platform), "acme", false);

    expect(calls).toHaveLength(0);
    expect(outcome.warning).toBeUndefined();
  });

  it("warns instead of silently swallowing a diff on kinds without the RPC", async () => {
    const { handler } = handlerWith({
      applyReturns: agent(ApiResourceVisibility.visibility_private),
    });

    const outcome = await applyMessage(controller, handler, agent(ApiResourceVisibility.visibility_platform), "acme", false);

    expect(outcome.warning).toMatch(/visibility cannot be changed declaratively/);
    expect(outcome.warning).toMatch(/stored value is kept/);
  });

  it("fails loudly when the guarded door rejects, naming the partial state", async () => {
    // e.g. the default-instance FAILED_PRECONDITION or an unsupported level.
    const { handler } = handlerWith({
      applyReturns: agent(ApiResourceVisibility.visibility_org),
      updateVisibility: () => Promise.reject(new Error("default instances do not have their own visibility")),
    });

    await expect(
      applyMessage(controller, handler, agent(ApiResourceVisibility.visibility_platform), "acme", false),
    ).rejects.toThrow(/spec applied, but the manifest's visibility change was rejected/);
  });

  it("does not follow up in dry-run mode", async () => {
    const { handler, calls } = handlerWith({
      applyReturns: agent(ApiResourceVisibility.visibility_org),
      updateVisibility: () => Promise.reject(new Error("must not be called")),
    });

    const outcome = await applyMessage(controller, handler, agent(ApiResourceVisibility.visibility_platform), "acme", true);

    expect(calls).toHaveLength(0);
    expect(outcome.applied).toBeUndefined();
  });
});

const ACME_ID = "org_01jaaaaaaaaaaaaaaaaaaaaaaa";

function organization(slug: string, id = ACME_ID) {
  return create(OrganizationSchema, { metadata: { id, name: "Acme", slug } });
}

function organizationHandler(applyReturns: Message, rename: (input: RenameInput) => Promise<Message>) {
  const calls: RenameInput[] = [];
  const handler: ApplyHandler = {
    kind: ApiResourceKind.organization,
    displayName: "Organization",
    schema: OrganizationSchema,
    applyOrder: 0,
    apply: () => Promise.resolve(applyReturns),
    rename: (_c: ControllerFn, input: RenameInput) => {
      calls.push(input);
      return rename(input);
    },
  };
  return { handler, calls };
}

describe("applyMessage declared-slug follow-up", () => {
  it("renames an organization whose manifest carries its id and a new slug, and reflects it on the outcome", async () => {
    const { handler, calls } = organizationHandler(organization("acme"), () => Promise.resolve(organization("acme-corp")));

    const outcome = await applyMessage(controller, handler, organization("acme-corp"), "", false);

    expect(calls).toHaveLength(1);
    expect(calls[0].resourceId).toBe(ACME_ID);
    expect(calls[0].slug).toBe("acme-corp");
    expect((outcome.applied as { metadata?: { slug?: string } }).metadata?.slug).toBe("acme-corp");
  });

  it("does not rename when the manifest carries no id (the slug is how apply finds it) or the same slug", async () => {
    const { handler, calls } = organizationHandler(organization("acme"), () => Promise.reject(new Error("must not be called")));

    await applyMessage(controller, handler, organization("acme-corp", ""), "", false);
    await applyMessage(controller, handler, organization("acme"), "", false);

    expect(calls).toHaveLength(0);
  });

  it("fails loudly when the rename is refused, naming the partial state", async () => {
    const { handler } = organizationHandler(organization("acme"), () => Promise.reject(new Error("the slug is taken")));

    await expect(applyMessage(controller, handler, organization("taken"), "", false)).rejects.toThrow(
      /spec applied, but the manifest's slug change was rejected: the slug is taken/,
    );
  });
});

describe("applyMessage org-mismatch warning", () => {
  /** A controller whose organization get answers the id each value names, or NotFound. */
  function organizationsNaming(ids: Record<string, string>): ControllerFn {
    return (() => ({
      get: ({ value }: { value: string }) =>
        ids[value] === undefined
          ? Promise.reject(new Error("not found"))
          : Promise.resolve(organization(value, ids[value])),
    })) as unknown as ControllerFn;
  }

  it("stays quiet when the manifest's org and the target name the same organization in different forms", async () => {
    const { handler } = handlerWith({ applyReturns: agent(ApiResourceVisibility.visibility_org) });
    const outcome = await applyMessage(
      organizationsNaming({ acme: ACME_ID, [ACME_ID]: ACME_ID }),
      handler,
      agent(ApiResourceVisibility.api_resource_visibility_unspecified),
      ACME_ID,
      true,
    );
    expect(outcome.warning).toBeUndefined();
  });

  it("warns when they name different organizations, or one the caller cannot see", async () => {
    const { handler } = handlerWith({ applyReturns: agent(ApiResourceVisibility.visibility_org) });
    const outcome = await applyMessage(
      organizationsNaming({ acme: ACME_ID, globex: "org_01jbbbbbbbbbbbbbbbbbbbbbbb" }),
      handler,
      agent(ApiResourceVisibility.api_resource_visibility_unspecified),
      "globex",
      true,
    );
    expect(outcome.warning).toMatch(/resource org 'acme' differs from target org 'globex'; using 'acme'/);
  });
});
