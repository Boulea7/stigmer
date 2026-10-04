/**
 * Pins ResolveAgentCallOrganizations (../agent-call-organizations.ts): an
 * agent_call task's literal `org/slug` agent and its environment references
 * store their organization by id, at every level a task can sit (top level,
 * nested in for, fork and try, and in compensation), with one lookup per
 * distinct name; a bare slug, a value fixed only at run, an id, a name
 * nobody holds, another kind's config and a config that does not decode are
 * left as written. Over a real store: a workflow naming a minted
 * organization by its slug saves, stores the id, and the reference rule
 * finds the agent, which it does not when the name is left a slug; a
 * rename later changes nothing the workflow calls.
 */
import { create } from "@bufbuild/protobuf";
import type { JsonObject } from "@bufbuild/protobuf";
import { ConnectError } from "@connectrpc/connect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentSchema } from "@stigmer/protos/ai/stigmer/agentic/agent/v1/api_pb";
import { EnvironmentSchema } from "@stigmer/protos/ai/stigmer/agentic/environment/v1/api_pb";
import type { Workflow } from "@stigmer/protos/ai/stigmer/agentic/workflow/v1/api_pb";
import { WorkflowSchema } from "@stigmer/protos/ai/stigmer/agentic/workflow/v1/api_pb";
import { WorkflowTaskKind } from "@stigmer/protos/ai/stigmer/agentic/workflow/v1/enum_pb";
import { WorkflowSpecSchema } from "@stigmer/protos/ai/stigmer/agentic/workflow/v1/spec_pb";
import { ApiResourceKind } from "@stigmer/protos/ai/stigmer/commons/apiresource/apiresourcekind/api_resource_kind_pb";
import { ApiResourceVisibility } from "@stigmer/protos/ai/stigmer/commons/apiresource/enum_pb";

import type { OrganizationNameResolver } from "../../../pipeline/interceptors/organization-names.js";
import { RequestContext } from "../../../pipeline/request-context.js";
import { testCallerIdentity } from "../../../pipeline/__tests__/support.js";
import { newPermissiveSingleTeamAuthorizer } from "../../../pipeline/steps/authorize.js";
import type { SqliteStore } from "../../../store/sqlite/store.js";
import { tempStore } from "../../../store/sqlite/__tests__/support.js";
import {
  newOrganizationNameResolver,
  organizationNameKey,
  RENAMED_SLUG_HOLD_MS,
} from "../../organization/names.js";
import { newResolveAgentCallOrganizationsStep } from "../agent-call-organizations.js";
import { newValidateAgentCallReferencesStep } from "../agent-call-references.js";

const ACME_ID = "org_01jaaaaaaaaaaaaaaaaaaaaaaa";
const GLOBEX_ID = "org_01jbbbbbbbbbbbbbbbbbbbbbbb";

/** A resolver over a fixed table, counting its lookups. */
function resolverOf(table: Record<string, string>): OrganizationNameResolver & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    resolve: (name: string) => {
      asked.push(name);
      return Promise.resolve(table[name]);
    },
  };
}

function workflowOf(tasks: ReadonlyArray<Record<string, unknown>>): Workflow {
  return create(WorkflowSchema, {
    apiVersion: "agentic.stigmer.ai/v1",
    kind: "Workflow",
    metadata: { id: "wfl_1", name: "Pipeline", org: ACME_ID },
    spec: create(WorkflowSpecSchema, { tasks } as never),
  });
}

function agentCall(name: string, config: JsonObject) {
  return { name, kind: WorkflowTaskKind.agent_call, taskConfig: { message: "do the thing", ...config } };
}

async function resolve(workflow: Workflow, resolver: OrganizationNameResolver): Promise<Workflow> {
  const ctx = new RequestContext(WorkflowSchema, workflow, testCallerIdentity(), ApiResourceKind.workflow);
  await newResolveAgentCallOrganizationsStep(resolver).execute(ctx);
  return ctx.newState;
}

describe("ResolveAgentCallOrganizations", () => {
  it("stores a literal's organization and every environment reference's by id, one lookup per name", async () => {
    const resolver = resolverOf({ acme: ACME_ID, globex: GLOBEX_ID });
    const workflow = await resolve(
      workflowOf([
        agentCall("review", {
          agent: "globex/reviewer",
          environment_refs: [{ org: "acme", slug: "keys" }, { slug: "relative" }, { org: GLOBEX_ID, slug: "theirs" }],
        }),
        agentCall("again", { agent: "globex/summarizer", environmentRefs: [{ org: "globex", slug: "more" }] }),
      ]),
      resolver,
    );

    const [review, again] = workflow.spec!.tasks;
    expect(review!.taskConfig).toEqual({
      message: "do the thing",
      agent: `${GLOBEX_ID}/reviewer`,
      environment_refs: [{ org: ACME_ID, slug: "keys" }, { slug: "relative" }, { org: GLOBEX_ID, slug: "theirs" }],
    });
    expect(again!.taskConfig).toMatchObject({
      agent: `${GLOBEX_ID}/summarizer`,
      environmentRefs: [{ org: GLOBEX_ID, slug: "more" }],
    });
    expect(resolver.asked.sort()).toEqual(["acme", "globex"]);
  });

  it("leaves a bare slug, a value fixed at run, an id, and a name nobody holds as written", async () => {
    const resolver = resolverOf({ acme: ACME_ID });
    const agents = ["reviewer", "${ .input.org }/reviewer", `${ACME_ID}/reviewer`, "nobody/reviewer"];
    const workflow = await resolve(
      workflowOf(agents.map((agent, i) => agentCall(`call_${i}`, { agent }))),
      resolver,
    );
    expect(workflow.spec!.tasks.map((task) => task.taskConfig?.agent)).toEqual(agents);
    expect(resolver.asked).toEqual(["nobody"]);
  });

  it("reaches agent calls nested in for, fork and try, and in compensation, at any depth", async () => {
    const nested = (name: string, agent: string) => ({ name, kind: "agent_call", task_config: { agent, message: "m" } });
    const workflow = await resolve(
      workflowOf([
        {
          name: "loop",
          kind: WorkflowTaskKind.for_each,
          taskConfig: {
            each: "item",
            in: "${ .items }",
            do: [
              {
                ...nested("in_loop", "acme/a"),
                compensate: [nested("undo_in_loop", "acme/b")],
              },
            ],
          },
        },
        {
          name: "split",
          kind: WorkflowTaskKind.fork,
          taskConfig: { branches: [{ name: "left", do: [nested("left_call", "acme/c")] }, { name: "right", do: [] }] },
        },
        {
          name: "guarded",
          kind: WorkflowTaskKind.try_catch,
          taskConfig: { try: [nested("try_call", "acme/d")], catch: { do: [nested("catch_call", "acme/e")] } },
          compensate: [agentCall("undo", { agent: "acme/f" })],
        },
      ]),
      resolverOf({ acme: ACME_ID }),
    );

    const [loop, split, guarded] = workflow.spec!.tasks;
    const inLoop = (loop!.taskConfig!.do as JsonObject[])[0]!;
    expect(inLoop.task_config).toMatchObject({ agent: `${ACME_ID}/a` });
    expect((inLoop.compensate as JsonObject[])[0]!.task_config).toMatchObject({ agent: `${ACME_ID}/b` });
    const left = ((split!.taskConfig!.branches as JsonObject[])[0]!.do as JsonObject[])[0]!;
    expect(left.task_config).toMatchObject({ agent: `${ACME_ID}/c` });
    expect((guarded!.taskConfig!.try as JsonObject[])[0]!.task_config).toMatchObject({ agent: `${ACME_ID}/d` });
    const caught = ((guarded!.taskConfig!.catch as JsonObject).do as JsonObject[])[0]!;
    expect(caught.task_config).toMatchObject({ agent: `${ACME_ID}/e` });
    expect(guarded!.compensate[0]!.taskConfig).toMatchObject({ agent: `${ACME_ID}/f` });
  });

  it("leaves other kinds, configs that do not decode, and a workflow with no spec alone", async () => {
    const resolver = resolverOf({ acme: ACME_ID });
    const workflow = await resolve(
      workflowOf([
        { name: "pause", kind: WorkflowTaskKind.wait, taskConfig: { duration: {} } },
        { name: "broken", kind: WorkflowTaskKind.agent_call, taskConfig: { agent: "acme/x", unknown_field: 1 } },
        { name: "empty", kind: WorkflowTaskKind.agent_call },
      ]),
      resolver,
    );
    expect(workflow.spec!.tasks[1]!.taskConfig).toEqual({ agent: "acme/x", unknown_field: 1 });
    expect(resolver.asked).toEqual([]);

    const bare = create(WorkflowSchema, { metadata: { id: "wfl_2", org: ACME_ID } });
    expect((await resolve(bare, resolver)).spec).toBeUndefined();
  });
});

describe("an agent call naming a minted organization by its slug, over a store", () => {
  let store: SqliteStore;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const temp = tempStore();
    store = temp.store;
    cleanup = temp.cleanup;
    await store.resourceNames.claim(organizationNameKey("acme"), ACME_ID, new Date().toISOString());
    await store.saveResource(
      ApiResourceKind.agent,
      "agt_reviewer",
      AgentSchema,
      create(AgentSchema, {
        apiVersion: "agentic.stigmer.ai/v1",
        kind: "Agent",
        metadata: {
          id: "agt_reviewer",
          name: "reviewer",
          slug: "reviewer",
          org: ACME_ID,
          visibility: ApiResourceVisibility.visibility_org,
        },
        spec: { instructions: "a conformant instruction body" },
      }),
    );
    await store.saveResource(
      ApiResourceKind.environment,
      "env_keys",
      EnvironmentSchema,
      create(EnvironmentSchema, { metadata: { id: "env_keys", name: "keys", slug: "keys", org: ACME_ID } }),
    );
  });

  afterEach(async () => {
    await cleanup();
  });

  function calling(): Workflow {
    const workflow = workflowOf([
      agentCall("review", { agent: "acme/reviewer", environment_refs: [{ org: "acme", slug: "keys" }] }),
    ]);
    workflow.metadata!.visibility = ApiResourceVisibility.visibility_org;
    return workflow;
  }

  async function save(workflow: Workflow, resolveFirst: boolean): Promise<Workflow> {
    const ctx = new RequestContext(WorkflowSchema, workflow, testCallerIdentity(), ApiResourceKind.workflow);
    if (resolveFirst) {
      await newResolveAgentCallOrganizationsStep(newOrganizationNameResolver(store)).execute(ctx);
    }
    await newValidateAgentCallReferencesStep(store, newPermissiveSingleTeamAuthorizer()).execute(ctx);
    return ctx.newState;
  }

  it("is refused while the name is left a slug: no agent is filed under it", async () => {
    await expect(save(calling(), false)).rejects.toBeInstanceOf(ConnectError);
  });

  it("saves with the organization's id, which a later rename and a new holder of the slug do not move", async () => {
    const saved = await save(calling(), true);
    expect(saved.spec!.tasks[0]!.taskConfig).toMatchObject({
      agent: `${ACME_ID}/reviewer`,
      environment_refs: [{ org: ACME_ID, slug: "keys" }],
    });

    const now = new Date();
    await store.resourceNames.rename({
      kind: "organization",
      org: "",
      id: ACME_ID,
      from: "acme",
      to: "acme-corp",
      fromExpiresAt: new Date(now.getTime() + RENAMED_SLUG_HOLD_MS).toISOString(),
      now: now.toISOString(),
    });
    const later = new Date(now.getTime() + RENAMED_SLUG_HOLD_MS + 1).toISOString();
    expect((await store.resourceNames.claim(organizationNameKey("acme"), GLOBEX_ID, later)).claimed).toBe(true);

    // Saved again as stored, the workflow still calls acme's agent.
    const resaved = await save(saved, true);
    expect(resaved.spec!.tasks[0]!.taskConfig).toMatchObject({ agent: `${ACME_ID}/reviewer` });
  });
});
