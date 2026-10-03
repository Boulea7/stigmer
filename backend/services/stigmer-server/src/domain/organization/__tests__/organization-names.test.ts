/**
 * Pins an organization's names (names.ts, rename.ts) through a composed
 * server in the trusted-local posture:
 *
 *   - a create mints an `org_` id, its slug resolves to it, and an
 *     organization naming an organization of its own is refused;
 *   - of two concurrent creates of one slug exactly one succeeds;
 *   - a create racing another create's young claim is a duplicate, while a
 *     claim older than a minute whose organization never landed is freed;
 *   - a pre-side-effect gate's refusal leaves no claim, and a create that
 *     fails after its row is stored keeps its name;
 *   - a delete releases the slug, and the next organization of that slug
 *     is a different organization;
 *   - a rename keeps the organization's id, leaves the old slug leading to
 *     it and refused to others, takes back its own old slug, is refused a
 *     slug another organization holds, and changes nothing when the slug is
 *     already its own; get, apply and update find a renamed organization by
 *     its old slug, and an apply carrying the id leaves the slug to rename.
 *
 * And, over store doubles, the two failure paths: the release a failed
 * create runs (it frees the claim only when the organization was never
 * stored, and every fault leaves the name claimed), and the move back a
 * rename whose row write fails runs.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { create } from "@bufbuild/protobuf";
import type { DescMessage } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import type { Client } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { RenameInputSchema } from "@stigmer/protos/ai/stigmer/commons/apiresource/io_pb";
import type { Organization } from "@stigmer/protos/ai/stigmer/tenancy/organization/v1/api_pb";
import { OrganizationSchema } from "@stigmer/protos/ai/stigmer/tenancy/organization/v1/api_pb";
import { OrganizationCommandController } from "@stigmer/protos/ai/stigmer/tenancy/organization/v1/command_pb";
import { OrganizationQueryController } from "@stigmer/protos/ai/stigmer/tenancy/organization/v1/query_pb";
import { ErrorInfoSchema } from "@stigmer/protos/google/rpc/error_details_pb";

import { loadConfig } from "../../../boot/config.js";
import { composeServer } from "../../../boot/compose.js";
import type { ComposedServer } from "../../../boot/compose.js";
import { createLogger } from "../../../boot/logger.js";
import type { Logger } from "../../../boot/logger.js";
import type { GateSlotName } from "../../../extensions/gate-slots.js";
import type { ServerExtension } from "../../../extensions/registry.js";
import type { PipelineStep } from "../../../pipeline/pipeline.js";
import { testCallerIdentity } from "../../../pipeline/__tests__/support.js";
import { RequestContext } from "../../../pipeline/request-context.js";
import {
  resetOperatorIdentityForTests,
  setOperatorIdentity,
} from "../../../pipeline/steps/defaults.js";
import { ResourceNotFoundError } from "../../../store/interface.js";
import type {
  ResourceNameEntry,
  ResourceNameRename,
  Store,
} from "../../../store/interface.js";
import { fakeIamPolicyStore } from "../../iampolicy/__tests__/support.js";
import {
  ABANDONED_NAME_AFTER_MS,
  ORGANIZATION_SLUG_RESERVED,
  RENAMED_SLUG_HOLD_MS,
  newClaimOrganizationSlugStep,
  organizationNameKey,
  releaseSlugClaimAfterFailure,
} from "../names.js";
import {
  RENAMED_ORGANIZATION_KEY,
  newPersistRenamedOrganizationStep,
  newRenameOrganizationSlugStep,
} from "../rename.js";

const OPERATOR_EMAIL = "operator@example.com";
const DUPLICATE_COPY = (slug: string) =>
  `Organization already exists: slug '${slug}'`;
const MINTED_ID = /^org_[0-9a-z]{26}$/;

async function grpcError(run: () => Promise<unknown>): Promise<ConnectError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ConnectError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the call to fail");
}

function organizationInput(slug: string) {
  return {
    apiVersion: "tenancy.stigmer.ai/v1",
    kind: "Organization",
    metadata: { name: slug, slug, org: "" },
    spec: { description: "created by the organization names test" },
  };
}

function reasonOf(error: ConnectError): string | undefined {
  return error.findDetails(ErrorInfoSchema)[0]?.reason;
}

describe("organization names (composed server, trusted-local posture)", () => {
  const policies = fakeIamPolicyStore();
  /** Slugs the pre-side-effect gate refuses while listed. */
  const gateRefuses = new Set<string>();
  /** Slugs whose post-persist step fails, after the row is stored. */
  const postPersistFails = new Set<string>();

  const slugOf = (organization: Organization) =>
    organization.metadata?.slug ?? "";
  const gateStep: PipelineStep<DescMessage> = {
    name: "FakeOrgLimitGate",
    execute: (ctx) => {
      if (gateRefuses.has(slugOf(ctx.newState as Organization))) {
        throw new ConnectError(
          "fake limit on organizations",
          Code.FailedPrecondition,
        );
      }
    },
  };
  const postPersistStep: PipelineStep<DescMessage> = {
    name: "FakeOrgPostPersist",
    execute: (ctx) => {
      if (postPersistFails.has(slugOf(ctx.newState as Organization))) {
        throw new ConnectError("fake companion failed", Code.Unavailable);
      }
    },
  };
  const unit: ServerExtension = {
    name: "fake-org-create",
    gateSteps: new Map<GateSlotName, ReadonlyArray<PipelineStep<DescMessage>>>([
      ["org-create:pre-side-effect-gate", [gateStep]],
      ["org-create:post-persist", [postPersistStep]],
    ]),
    drivers: { iamPolicyStore: policies },
  };

  let dir: string;
  let server: ComposedServer;
  let organizations: Client<typeof OrganizationCommandController>;
  let organizationQuery: Client<typeof OrganizationQueryController>;

  const resolve = (slug: string) =>
    server.store.resourceNames.resolve(
      organizationNameKey(slug),
      new Date().toISOString(),
    );
  const ownersOf = (org: string) =>
    [...policies.rows.values()].filter(
      (policy) =>
        policy.spec?.resource?.kind === "organization" &&
        policy.spec.resource.id === org &&
        policy.spec.relation === "owner",
    ).length;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "organization-names-test-"));
    setOperatorIdentity(OPERATOR_EMAIL, "The Operator");
    server = await composeServer({
      config: loadConfig({
        STIGMER_MODEL_REGISTRY_REFRESH: "off",
        TEMPORAL_HOST_PORT: "127.0.0.1:1",
        DB_PATH: path.join(dir, "stigmer.db"),
        STORAGE_PATH: path.join(dir, "storage"),
        ARTIFACT_LOCAL_BASE_PATH: path.join(dir, "artifacts"),
        STIGMER_OPERATOR_EMAIL: OPERATOR_EMAIL,
      }),
      logger: createLogger({ level: "error", pretty: false, write: () => {} }),
      extensions: [unit],
      portOverride: 0,
      host: "127.0.0.1",
    });
    const port = await server.start();
    const transport = createGrpcTransport({
      baseUrl: `http://127.0.0.1:${port}`,
    });
    organizations = createClient(OrganizationCommandController, transport);
    organizationQuery = createClient(OrganizationQueryController, transport);
  });

  afterAll(async () => {
    await server.shutdown();
    resetOperatorIdentityForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    gateRefuses.clear();
    postPersistFails.clear();
  });

  it("a create mints an org_ id, and its slug resolves to it", async () => {
    const created = await organizations.create(organizationInput("minted"));
    const id = created.metadata?.id ?? "";
    expect(id).toMatch(MINTED_ID);
    expect(created.metadata?.slug).toBe("minted");
    expect(created.metadata?.org).toBe("");
    expect((await resolve("minted"))?.id).toBe(id);
    expect(
      (await organizationQuery.get({ value: "minted" })).metadata?.id,
      "get by slug resolves to the organization",
    ).toBe(id);
  });

  it("an organization that names an organization of its own is refused", async () => {
    const refusal = await grpcError(() =>
      organizations.create({
        ...organizationInput("nested"),
        metadata: { name: "nested", slug: "nested", org: "minted" },
      }),
    );
    expect(refusal.code).toBe(Code.InvalidArgument);
    expect(refusal.rawMessage).toMatch(/belongs to no organization/);
    expect(await resolve("nested")).toBeUndefined();
  });

  it("of two concurrent creates of one slug, exactly one succeeds and the other is a duplicate", async () => {
    const results = await Promise.allSettled([
      organizations.create(organizationInput("contended")),
      organizations.create(organizationInput("contended")),
    ]);
    const made = results.filter(
      (result): result is PromiseFulfilledResult<Organization> =>
        result.status === "fulfilled",
    );
    expect(made).toHaveLength(1);
    const [rejected] = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    const refusal = ConnectError.from(rejected?.reason);
    expect(refusal.code).toBe(Code.AlreadyExists);
    expect(refusal.rawMessage).toBe(DUPLICATE_COPY("contended"));
    expect(ownersOf(made[0]!.value.metadata?.id ?? "")).toBe(1);
  });

  it("a create racing another create's young claim is a duplicate; an abandoned claim is freed", async () => {
    await server.store.resourceNames.claim(
      organizationNameKey("in-flight"),
      "org_00000000000000000000000000",
      new Date().toISOString(),
    );
    const refusal = await grpcError(() =>
      organizations.create(organizationInput("in-flight")),
    );
    expect(refusal.code).toBe(Code.AlreadyExists);
    expect(refusal.rawMessage).toBe(DUPLICATE_COPY("in-flight"));

    await server.store.resourceNames.claim(
      organizationNameKey("abandoned"),
      "org_11111111111111111111111111",
      new Date(Date.now() - ABANDONED_NAME_AFTER_MS - 1000).toISOString(),
    );
    const made = await organizations.create(organizationInput("abandoned"));
    expect(made.metadata?.id).toMatch(MINTED_ID);
    expect((await resolve("abandoned"))?.id).toBe(made.metadata?.id);
  });

  it("a pre-side-effect gate's refusal leaves no claim, so the create succeeds once the gate lets it", async () => {
    gateRefuses.add("gated");
    const refusal = await grpcError(() =>
      organizations.create(organizationInput("gated")),
    );
    expect(refusal.code).toBe(Code.FailedPrecondition);
    expect(await resolve("gated")).toBeUndefined();

    gateRefuses.delete("gated");
    const created = await organizations.create(organizationInput("gated"));
    expect(created.metadata?.id).toMatch(MINTED_ID);
  });

  it("a create that fails after its row is stored keeps its name", async () => {
    postPersistFails.add("half-made");
    const refusal = await grpcError(() =>
      organizations.create(organizationInput("half-made")),
    );
    expect(refusal.code).toBe(Code.Unavailable);

    const id = (await resolve("half-made"))?.id ?? "";
    expect(id).toMatch(MINTED_ID);
    expect(
      (await organizationQuery.get({ value: "half-made" })).metadata?.id,
    ).toBe(id);

    postPersistFails.delete("half-made");
    const retry = await grpcError(() =>
      organizations.create(organizationInput("half-made")),
    );
    expect(retry.code).toBe(Code.AlreadyExists);
    expect(retry.rawMessage).toBe(DUPLICATE_COPY("half-made"));
  });

  it("a delete releases the slug, and the next organization of that slug is a different one", async () => {
    const first = await organizations.create(organizationInput("reused"));
    await organizations.delete({ value: "reused" });
    expect(await resolve("reused")).toBeUndefined();

    const second = await organizations.create(organizationInput("reused"));
    expect(second.metadata?.id).toMatch(MINTED_ID);
    expect(second.metadata?.id).not.toBe(first.metadata?.id);
  });

  it("a rename keeps the id; the old slug leads to the organization and is refused to others until it expires", async () => {
    const made = await organizations.create(organizationInput("acme"));
    const id = made.metadata?.id ?? "";

    const renamed = await organizations.rename(
      create(RenameInputSchema, { resourceId: "acme", slug: "acme-corp" }),
    );
    expect(renamed.metadata?.id).toBe(id);
    expect(renamed.metadata?.slug).toBe("acme-corp");
    expect(renamed.status?.audit?.specAudit?.event).toBe("renamed");

    expect((await organizationQuery.get({ value: "acme" })).metadata?.id).toBe(id);
    expect((await organizationQuery.get({ value: "acme-corp" })).metadata?.slug).toBe(
      "acme-corp",
    );
    const old = await resolve("acme");
    expect(old?.state).toBe("previous");
    const held = Date.parse(old?.expiresAt ?? "") - Date.now();
    expect(held).toBeGreaterThan(RENAMED_SLUG_HOLD_MS - 60_000);
    expect(held).toBeLessThanOrEqual(RENAMED_SLUG_HOLD_MS);

    const taken = await grpcError(() =>
      organizations.create(organizationInput("acme")),
    );
    expect(taken.code).toBe(Code.AlreadyExists);
    expect(reasonOf(taken)).toBe(ORGANIZATION_SLUG_RESERVED);
  });

  it("a rename takes back its own old slug, is refused another's slug, and changes nothing for its own", async () => {
    const made = await organizations.create(organizationInput("initech"));
    await organizations.create(organizationInput("umbrella"));
    await organizations.rename(
      create(RenameInputSchema, { resourceId: made.metadata?.id, slug: "initech-co" }),
    );

    const back = await organizations.rename(
      create(RenameInputSchema, { resourceId: made.metadata?.id, slug: "initech" }),
    );
    expect(back.metadata?.slug).toBe("initech");
    expect((await resolve("initech"))?.state).toBe("current");

    const refusal = await grpcError(() =>
      organizations.rename(
        create(RenameInputSchema, { resourceId: made.metadata?.id, slug: "umbrella" }),
      ),
    );
    expect(refusal.code).toBe(Code.AlreadyExists);
    expect(refusal.rawMessage).toBe(DUPLICATE_COPY("umbrella"));

    const same = await organizations.rename(
      create(RenameInputSchema, { resourceId: made.metadata?.id, slug: "initech" }),
    );
    expect(same.metadata?.slug).toBe("initech");
  });

  it("apply and update find a renamed organization by its old slug; an apply carrying the id keeps the slug", async () => {
    const made = await organizations.create(organizationInput("hooli"));
    const id = made.metadata?.id ?? "";
    await organizations.rename(
      create(RenameInputSchema, { resourceId: id, slug: "hooli-xyz" }),
    );

    const applied = await organizations.apply({
      ...organizationInput("hooli"),
      spec: { description: "applied by the old slug" },
    });
    expect(applied.metadata?.id).toBe(id);
    expect(applied.metadata?.slug).toBe("hooli-xyz");

    const withId = await organizations.apply({
      ...organizationInput("hooli-new"),
      metadata: { name: "hooli", slug: "hooli-new", id, org: "" },
    });
    expect(withId.metadata?.id).toBe(id);
    expect(withId.metadata?.slug, "an apply never renames").toBe("hooli-xyz");
    expect(await resolve("hooli-new")).toBeUndefined();

    const updated = await organizations.update({
      ...organizationInput("hooli"),
      spec: { description: "updated by the old slug" },
    });
    expect(updated.metadata?.id).toBe(id);
    expect(updated.spec?.description).toBe("updated by the old slug");
  });
});

describe("releaseSlugClaimAfterFailure", () => {
  const entry: ResourceNameEntry = {
    ...organizationNameKey("acme"),
    id: "org_01jaaaaaaaaaaaaaaaaaaaaaaa",
    state: "current",
    claimedAt: "2026-09-28T00:00:00.000Z",
    expiresAt: "",
  };

  function logger(): Logger & { errors: string[] } {
    const errors: string[] = [];
    return {
      errors,
      error: (message: string) => errors.push(message),
      warn: () => {},
      info: () => {},
      debug: () => {},
    } as unknown as Logger & { errors: string[] };
  }

  /** A store double: the organization row's read and the name table's claim and release. */
  function storeWith(
    rowRead: () => Promise<unknown>,
    release: (kind: string, org: string, id: string) => Promise<void>,
  ): Store {
    return {
      getResource: rowRead,
      resourceNames: {
        claim: async () => ({ claimed: true, entry }),
        release,
      },
    } as unknown as Store;
  }

  /** A request whose ClaimOrganizationSlug won `entry`. */
  async function claimedRequest(): Promise<
    RequestContext<typeof OrganizationSchema>
  > {
    const ctx = new RequestContext(
      OrganizationSchema,
      create(OrganizationSchema, {
        metadata: { slug: "acme", id: entry.id },
      }),
      testCallerIdentity(),
    );
    const claiming = {
      resourceNames: { claim: async () => ({ claimed: true, entry }) },
    } as unknown as Store;
    await newClaimOrganizationSlugStep(claiming).execute(ctx);
    return ctx;
  }

  it("frees the claim when the organization was never stored", async () => {
    const release = vi.fn(async () => {});
    const store = storeWith(async () => {
      throw new ResourceNotFoundError("organization acme");
    }, release);

    await releaseSlugClaimAfterFailure(store, logger(), await claimedRequest());
    expect(release).toHaveBeenCalledWith("organization", "", entry.id);
  });

  it("keeps the claim when the organization was stored", async () => {
    const release = vi.fn(async () => {});
    await releaseSlugClaimAfterFailure(
      storeWith(async () => ({}), release),
      logger(),
      await claimedRequest(),
    );
    expect(release).not.toHaveBeenCalled();
  });

  it("keeps the claim, and logs, when the row cannot be read or the release faults", async () => {
    const release = vi.fn(async () => {});
    const unreadable = logger();
    await releaseSlugClaimAfterFailure(
      storeWith(async () => {
        throw new Error("database locked");
      }, release),
      unreadable,
      await claimedRequest(),
    );
    expect(release).not.toHaveBeenCalled();
    expect(unreadable.errors).toHaveLength(1);

    const faulting = logger();
    await releaseSlugClaimAfterFailure(
      storeWith(
        async () => {
          throw new ResourceNotFoundError("organization acme");
        },
        async () => {
          throw new Error("database locked");
        },
      ),
      faulting,
      await claimedRequest(),
    );
    expect(faulting.errors).toHaveLength(1);
  });

  it("does nothing for a request that never claimed", async () => {
    const release = vi.fn(async () => {});
    const unclaimed = new RequestContext(
      OrganizationSchema,
      create(OrganizationSchema, { metadata: { slug: "acme" } }),
      testCallerIdentity(),
    );
    await releaseSlugClaimAfterFailure(
      storeWith(async () => {
        throw new ResourceNotFoundError("organization acme");
      }, release),
      logger(),
      unclaimed,
    );
    expect(release).not.toHaveBeenCalled();
  });
});

describe("a rename whose row write fails", () => {
  function renameRequest() {
    const organization = create(OrganizationSchema, {
      metadata: { id: "org_01jaaaaaaaaaaaaaaaaaaaaaaa", slug: "acme" },
    });
    const ctx = new RequestContext(
      RenameInputSchema,
      create(RenameInputSchema, {
        resourceId: "org_01jaaaaaaaaaaaaaaaaaaaaaaa",
        slug: "acme-corp",
      }),
      testCallerIdentity(),
    );
    ctx.set(RENAMED_ORGANIZATION_KEY, organization);
    return ctx;
  }

  it("moves the names back and fails; a failed move back is logged and the write's error stands", async () => {
    const moves: ResourceNameRename[] = [];
    const reverts: ResourceNameRename[] = [];
    let revertFails = false;
    const store = {
      resourceNames: {
        rename: async (move: ResourceNameRename) => {
          moves.push(move);
          return {
            claimed: true,
            entry: { ...organizationNameKey(move.to), id: move.id, state: "current", claimedAt: move.now, expiresAt: "" },
          };
        },
        revertRename: async (move: ResourceNameRename) => {
          if (revertFails) {
            throw new Error("database locked");
          }
          reverts.push(move);
        },
      },
      saveResource: async () => {
        throw new Error("disk full");
      },
    } as unknown as Store;
    const errors: string[] = [];
    const logger = {
      error: (message: string) => errors.push(message),
      warn: () => {},
      info: () => {},
      debug: () => {},
    } as unknown as Logger;

    const ctx = renameRequest();
    await newRenameOrganizationSlugStep(store).execute(ctx);
    await expect(
      newPersistRenamedOrganizationStep(store, logger).execute(ctx),
    ).rejects.toThrow();
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ from: "acme", to: "acme-corp" });
    expect(reverts).toEqual(moves);

    revertFails = true;
    const again = renameRequest();
    await newRenameOrganizationSlugStep(store).execute(again);
    await expect(
      newPersistRenamedOrganizationStep(store, logger).execute(again),
    ).rejects.toThrow();
    expect(errors).toHaveLength(1);
  });
});
