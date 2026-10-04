import { create } from "@bufbuild/protobuf";
import { McpServerSchema } from "@stigmer/protos/ai/stigmer/agentic/mcpserver/v1/api_pb";
import { OrganizationSchema } from "@stigmer/protos/ai/stigmer/tenancy/organization/v1/api_pb";
import type { Stigmer } from "@stigmer/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UsageError } from "../../../errors/index.js";
import {
  browserCommand,
  runOAuthFlow,
  waitForOAuthGrant,
  type OAuthFlowDeps,
} from "../oauth.js";

const server = create(McpServerSchema, {
  metadata: { id: "mcp_1", slug: "github", name: "GitHub" },
});

// A fake client whose getOAuthGrantStatus reports `connected` once the call
// count reaches `connectOnCall` (1 = first poll). Records the call count.
function fakeClient(connectOnCall: number): {
  client: Stigmer;
  calls: () => number;
} {
  let calls = 0;
  const client = {
    mcpServer: {
      getOAuthGrantStatus: async () => {
        calls += 1;
        return { connected: calls >= connectOnCall };
      },
    },
  } as unknown as Stigmer;
  return { client, calls: () => calls };
}

const noopSleep = async (): Promise<void> => {};

describe("browserCommand", () => {
  it("maps each supported platform to its opener", () => {
    expect(browserCommand("darwin", "https://x")).toEqual([
      "open",
      ["https://x"],
    ]);
    expect(browserCommand("linux", "https://x")).toEqual([
      "xdg-open",
      ["https://x"],
    ]);
    expect(browserCommand("win32", "https://x")).toEqual([
      "rundll32",
      ["url.dll,FileProtocolHandler", "https://x"],
    ]);
  });

  it("returns no command for unsupported platforms", () => {
    expect(browserCommand("aix", "https://x")[0]).toBeUndefined();
  });
});

describe("waitForOAuthGrant", () => {
  it("resolves once the grant connects on a later poll", async () => {
    const { client, calls } = fakeClient(3);
    const deps: OAuthFlowDeps = {
      client,
      server,
      org: "acme",
      consoleURL: "https://app.stigmer.ai",
      probeLocalConsole: false,
      now: () => 0,
      sleep: noopSleep,
      log: () => {},
    };
    await expect(waitForOAuthGrant(deps)).resolves.toBeUndefined();
    expect(calls()).toBe(3);
  });

  it("throws a UsageError when the poll window elapses", async () => {
    const { client, calls } = fakeClient(Number.POSITIVE_INFINITY);
    // First now() seeds the deadline; the next jumps past it to force a timeout
    // before any grant check runs.
    const clock = [0, 10 * 60 * 1000];
    const deps: OAuthFlowDeps = {
      client,
      server,
      org: "acme",
      consoleURL: "https://app.stigmer.ai",
      probeLocalConsole: false,
      now: () => clock.shift() ?? 10 * 60 * 1000,
      sleep: noopSleep,
      log: () => {},
    };
    await expect(waitForOAuthGrant(deps)).rejects.toThrow(UsageError);
    expect(calls()).toBe(0);
  });
});

describe("runOAuthFlow", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens the org's MCP-server page then waits for the grant", async () => {
    const { client } = fakeClient(1);
    const openBrowser = vi.fn(async () => {});
    await runOAuthFlow({
      client,
      server,
      org: "acme",
      consoleURL: "https://app.stigmer.ai",
      probeLocalConsole: false,
      openBrowser,
      now: () => 0,
      sleep: noopSleep,
      log: () => {},
    });
    expect(openBrowser).toHaveBeenCalledWith(
      "https://app.stigmer.ai/library/mcp-servers/acme/github",
    );
  });

  it("names the server's organization by slug in the page URL where the server stores its id", async () => {
    const id = "org_01jaaaaaaaaaaaaaaaaaaaaaaa";
    const { client } = fakeClient(1);
    const knowingAcme = {
      ...client,
      organization: {
        get: async (value: string) => {
          if (value !== id) throw new Error("organization not found");
          return create(OrganizationSchema, { metadata: { id, slug: "acme" } });
        },
      },
    } as unknown as Stigmer;
    const openBrowser = vi.fn(async () => {});
    const deps = {
      client: knowingAcme,
      org: "",
      consoleURL: "https://app.stigmer.ai",
      probeLocalConsole: false,
      openBrowser,
      now: () => 0,
      sleep: noopSleep,
      log: () => {},
    };
    await runOAuthFlow({
      ...deps,
      server: create(McpServerSchema, { metadata: { id: "mcp_1", slug: "github", org: id } }),
    });
    // One the caller cannot see keeps the id, which the console's route also takes.
    const hidden = "org_01jbbbbbbbbbbbbbbbbbbbbbbb";
    await runOAuthFlow({
      ...deps,
      server: create(McpServerSchema, { metadata: { id: "mcp_1", slug: "github", org: hidden } }),
    });
    expect(openBrowser.mock.calls).toEqual([
      ["https://app.stigmer.ai/library/mcp-servers/acme/github"],
      [`https://app.stigmer.ai/library/mcp-servers/${hidden}/github`],
    ]);
  });

  it("aborts before opening the browser when the local console is unreachable", async () => {
    const { client } = fakeClient(1);
    const openBrowser = vi.fn(async () => {});
    await expect(
      runOAuthFlow({
        client,
        server,
        org: "acme",
        consoleURL: "http://localhost:7234",
        probeLocalConsole: true,
        probeConsole: async () => false,
        openBrowser,
        now: () => 0,
        sleep: noopSleep,
        log: () => {},
      }),
    ).rejects.toThrow(UsageError);
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it("opens the local console page when the probe succeeds", async () => {
    const { client } = fakeClient(1);
    const openBrowser = vi.fn(async () => {});
    await runOAuthFlow({
      client,
      server,
      org: "acme",
      consoleURL: "http://localhost:7234",
      probeLocalConsole: true,
      probeConsole: async () => true,
      openBrowser,
      now: () => 0,
      sleep: noopSleep,
      log: () => {},
    });
    expect(openBrowser).toHaveBeenCalledWith(
      "http://localhost:7234/library/mcp-servers/acme/github",
    );
  });
});
