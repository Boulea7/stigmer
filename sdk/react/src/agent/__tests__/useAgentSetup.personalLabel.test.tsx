/**
 * A personal instance is found by the label its create gave it. The create
 * (buildPersonalInstanceInput) labels it with the active organization's id
 * and the agent's slug; the lookup must ask for that same label, even when
 * the reference it resolves names the organization by slug (a Start-session
 * link's `?agent=acme/reviewer`). Pinned: the lookup's label equals the
 * builder's, an agent with a saved instance resolves to it instead of
 * asking for its variables again, and saving the variables re-checks and
 * creates under that one label. The label names the agent by slug, which an
 * organization's agent and the platform's can share, so a found instance is
 * taken only when it binds the agent being resolved.
 */

import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { create } from "@bufbuild/protobuf";
import { createRouterTransport } from "@connectrpc/connect";
import { Stigmer } from "@stigmer/sdk";
import { AgentQueryController } from "@stigmer/protos/ai/stigmer/agentic/agent/v1/query_pb";
import { AgentInstanceQueryController } from "@stigmer/protos/ai/stigmer/agentic/agentinstance/v1/query_pb";
import { AgentInstanceCommandController } from "@stigmer/protos/ai/stigmer/agentic/agentinstance/v1/command_pb";
import { EnvironmentCommandController } from "@stigmer/protos/ai/stigmer/agentic/environment/v1/command_pb";
import { EnvironmentSchema } from "@stigmer/protos/ai/stigmer/agentic/environment/v1/api_pb";
import { AgentInstanceListSchema } from "@stigmer/protos/ai/stigmer/agentic/agentinstance/v1/io_pb";
import { AgentInstanceSchema } from "@stigmer/protos/ai/stigmer/agentic/agentinstance/v1/api_pb";
import { type Agent, AgentSchema } from "@stigmer/protos/ai/stigmer/agentic/agent/v1/api_pb";
import { AgentSpecSchema } from "@stigmer/protos/ai/stigmer/agentic/agent/v1/spec_pb";
import { EnvVarDeclarationSchema } from "@stigmer/protos/ai/stigmer/agentic/environment/v1/spec_pb";
import { EnvironmentQueryController } from "@stigmer/protos/ai/stigmer/agentic/environment/v1/query_pb";
import { EnvironmentListSchema } from "@stigmer/protos/ai/stigmer/agentic/environment/v1/io_pb";
import { ApiResourceMetadataSchema } from "@stigmer/protos/ai/stigmer/commons/apiresource/metadata_pb";
import { ApiResourceKind } from "@stigmer/protos/ai/stigmer/commons/apiresource/apiresourcekind/api_resource_kind_pb";

import { StigmerContext } from "../../context";
import { FetchCacheContext } from "../../internal/FetchCacheProvider";
import {
  buildPersonalInstanceInput,
  personalInstanceAgentLabel,
} from "../../agent-instance/buildPersonalInstanceInput";
import { useAgentSetup } from "../useAgentSetup";

afterEach(cleanup);

const ACME_ID = "org_01jaaaaaaaaaaaaaaaaaaaaaaa";
const FOR_AGENT = "stigmer.ai/for-agent";

/** The organization's own `reviewer`, the agent the saved instance binds. */
const ACME_REVIEWER = create(AgentSchema, {
  metadata: create(ApiResourceMetadataSchema, { id: "agt_1", org: ACME_ID, slug: "reviewer", name: "Reviewer" }),
  spec: create(AgentSpecSchema, {
    env: { API_TOKEN: create(EnvVarDeclarationSchema, { isSecret: true, description: "API token" }) },
  }),
});

/** The platform's `reviewer`: the same slug in another organization, with no saved instance. */
const PLATFORM_REVIEWER = create(AgentSchema, {
  metadata: create(ApiResourceMetadataSchema, { id: "agt_platform", org: "stigmer", slug: "reviewer", name: "Reviewer" }),
  spec: ACME_REVIEWER.spec,
});

/**
 * A client whose saved personal instance (when `saved`) binds the acme
 * reviewer and answers only the label the builder gives it, from the
 * `savedFrom`th list on (a tab that saved it in between); its agent get
 * answers `agent`.
 */
function client(
  asked: Record<string, string>[],
  created: Record<string, string>[] = [],
  saved = true,
  agent: Agent = ACME_REVIEWER,
  savedFrom = 1,
) {
  const existing = buildPersonalInstanceInput({
    org: ACME_ID,
    agentId: "agt_1",
    agentSlug: "reviewer",
    environmentRef: { org: ACME_ID, slug: "personal", kind: ApiResourceKind.environment },
  });
  return new Stigmer({
    baseUrl: "/",
    getAccessToken: () => "t",
    customTransport: createRouterTransport(({ service }) => {
      service(AgentQueryController, { getByReference: () => agent });
      service(AgentInstanceQueryController, {
        list: (request) => {
          asked.push({ ...request.labels });
          const matches =
            saved && asked.length >= savedFrom && request.labels[FOR_AGENT] === existing.labels?.[FOR_AGENT];
          return create(AgentInstanceListSchema, {
            items: matches
              ? [
                  create(AgentInstanceSchema, {
                    metadata: create(ApiResourceMetadataSchema, { id: "ain_saved", org: ACME_ID }),
                    spec: { agentId: "agt_1" },
                  }),
                ]
              : [],
          });
        },
      });
      service(EnvironmentQueryController, { list: () => create(EnvironmentListSchema, { items: [] }) });
      service(AgentInstanceCommandController, {
        create: (instance) => {
          created.push({ ...instance.metadata?.labels, agentId: instance.spec?.agentId ?? "" });
          return create(AgentInstanceSchema, { metadata: create(ApiResourceMetadataSchema, { id: "ain_new", org: ACME_ID }) });
        },
      });
      service(EnvironmentCommandController, {
        create: () =>
          create(EnvironmentSchema, { metadata: create(ApiResourceMetadataSchema, { id: "env_1", org: ACME_ID, slug: "personal" }) }),
        updateVariables: () =>
          create(EnvironmentSchema, { metadata: create(ApiResourceMetadataSchema, { id: "env_1", org: ACME_ID, slug: "personal" }) }),
      });
    }),
  });
}

function wrapper(stigmer: Stigmer) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <FetchCacheContext.Provider value={null}>
        <StigmerContext.Provider value={stigmer}>{children}</StigmerContext.Provider>
      </FetchCacheContext.Provider>
    );
  };
}

describe("useAgentSetup's personal-instance label", () => {
  it("is the label the builder gives a personal instance: the active organization's id and the agent's slug", () => {
    expect(personalInstanceAgentLabel(ACME_ID, "reviewer")).toBe(`${ACME_ID}/reviewer`);
    const input = buildPersonalInstanceInput({
      org: ACME_ID,
      agentId: "agt_1",
      agentSlug: "reviewer",
      environmentRef: { org: ACME_ID, slug: "personal", kind: ApiResourceKind.environment },
    });
    expect(input.labels?.[FOR_AGENT]).toBe(personalInstanceAgentLabel(ACME_ID, "reviewer"));
  });

  it("finds the saved instance when the reference names the organization by slug", async () => {
    const asked: Record<string, string>[] = [];
    const { result } = renderHook(() => useAgentSetup(ACME_ID), { wrapper: wrapper(client(asked)) });

    await act(async () => {
      await result.current.resolveAgent({ org: "acme", slug: "reviewer" });
    });

    expect(asked.map((labels) => labels[FOR_AGENT])).toContain(`${ACME_ID}/reviewer`);
    expect(asked.map((labels) => labels[FOR_AGENT])).not.toContain("acme/reviewer");
    expect(result.current.state.status).toBe("ready");
    if (result.current.state.status === "ready") {
      expect(result.current.state.resolution).toEqual({ mode: "saved", instanceId: "ain_saved" });
    }
  });

  it("saves the variables, re-checks, and creates the instance under the same label", async () => {
    const asked: Record<string, string>[] = [];
    const created: Record<string, string>[] = [];
    const { result } = renderHook(() => useAgentSetup(ACME_ID), { wrapper: wrapper(client(asked, created, false)) });

    await act(async () => {
      await result.current.resolveAgent({ org: "acme", slug: "reviewer" });
    });
    expect(result.current.state.status).toBe("needsEnvVars");
    // The personal environment's list must have settled before a save.
    await waitFor(async () => {
      await act(async () => {
        await result.current.submitEnvVars({ API_TOKEN: { value: "t", isSecret: true } }, { saveForFuture: true });
      });
    });

    const label = `${ACME_ID}/reviewer`;
    expect(asked.map((labels) => labels[FOR_AGENT])).toEqual([label, label]);
    expect(created.map((labels) => labels[FOR_AGENT])).toEqual([label]);
    expect(result.current.state.status).toBe("ready");
  });

  it("takes the instance another tab saved for the agent between the lookup and the save, creating none", async () => {
    const asked: Record<string, string>[] = [];
    const created: Record<string, string>[] = [];
    const { result } = renderHook(() => useAgentSetup(ACME_ID), {
      wrapper: wrapper(client(asked, created, true, ACME_REVIEWER, 2)),
    });

    await act(async () => {
      await result.current.resolveAgent({ org: "acme", slug: "reviewer" });
    });
    expect(result.current.state.status).toBe("needsEnvVars");
    await waitFor(async () => {
      await act(async () => {
        await result.current.submitEnvVars({ API_TOKEN: { value: "t", isSecret: true } }, { saveForFuture: true });
      });
    });

    expect(created).toEqual([]);
    expect(result.current.state.status).toBe("ready");
    if (result.current.state.status === "ready") {
      expect(result.current.state.resolution).toEqual({ mode: "saved", instanceId: "ain_saved" });
    }
  });

  it("never answers another agent's saved instance for a same-slug agent in another organization", async () => {
    const asked: Record<string, string>[] = [];
    const created: Record<string, string>[] = [];
    const { result } = renderHook(() => useAgentSetup(ACME_ID), {
      wrapper: wrapper(client(asked, created, true, PLATFORM_REVIEWER)),
    });

    // The label query answers the acme reviewer's instance; it binds another agent.
    await act(async () => {
      await result.current.resolveAgent({ org: "stigmer", slug: "reviewer" });
    });
    expect(asked.map((labels) => labels[FOR_AGENT])).toEqual([`${ACME_ID}/reviewer`]);
    expect(result.current.state.status).toBe("needsEnvVars");

    // Saving re-checks under the same label and creates one for the platform agent.
    await waitFor(async () => {
      await act(async () => {
        await result.current.submitEnvVars({ API_TOKEN: { value: "t", isSecret: true } }, { saveForFuture: true });
      });
    });
    expect(created.map((labels) => labels.agentId)).toEqual(["agt_platform"]);
    expect(result.current.state.status).toBe("ready");
    if (result.current.state.status === "ready") {
      expect(result.current.state.resolution).toEqual({ mode: "saved", instanceId: "ain_new" });
    }
  });
});
