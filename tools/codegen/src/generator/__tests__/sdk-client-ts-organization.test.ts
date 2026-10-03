/**
 * Pins how the TypeScript SDK generator carries an organization in a
 * resource's input and in the mapper that turns a loaded resource into an
 * update input. An organization-scoped kind (Agent) takes its organization
 * and carries it over on update. An organization-less kind takes none: its
 * input's `org` is the empty string type, documented as belonging to no
 * organization, and its update mapper carries none over. Organization is
 * such a kind: it belongs to no organization, so its update addresses it by
 * id, never by an `org` filled from its own slug as it once was.
 *
 * The generator runs over the real schemas into a temporary directory, and
 * these cases read what it wrote.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runSDKClientTSGeneration } from "../sdk-client-ts.js";

const SCHEMAS = path.resolve(__dirname, "../../../schemas");

/** The generated function that starts at `marker`, to its closing brace; a missing one fails the case. */
function from(text: string, marker: string): string {
  const at = text.indexOf(marker);
  expect(at, `${marker} was generated`).toBeGreaterThanOrEqual(0);
  const end = text.indexOf("\n}\n", at);
  expect(end, `${marker} closes`).toBeGreaterThan(at);
  return text.slice(at, end);
}

describe("the TypeScript SDK's inputs carry an organization only for kinds that have one", () => {
  let root: string;
  let organization: string;
  let agent: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "codegen-ts-org-"));
    runSDKClientTSGeneration(SCHEMAS, root);
    organization = fs.readFileSync(path.join(root, "organization.ts"), "utf8");
    agent = fs.readFileSync(path.join(root, "agent.ts"), "utf8");
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("an organization's input takes no organization, and says why", () => {
    expect(organization).toContain(
      "   * Always empty: a Organization belongs to no organization, so\n" +
        "   * `metadata.org` stays unset. Omit it.\n" +
        "   */\n" +
        '  org?: "";\n',
    );
    expect(organization).not.toContain("  org: string;\n");
  });

  it("an organization's update mapper carries no organization over, addressing it by id", () => {
    const mapper = from(organization, "export function toOrganizationUpdateInput");
    expect(mapper).toContain("    id: meta?.id || undefined,\n");
    expect(mapper).not.toMatch(/^\s+org:/m);
  });

  it("an organization-scoped kind's input takes its organization, and its update mapper carries it over", () => {
    expect(agent).toContain("  org: string;\n");
    const mapper = from(agent, "export function toAgentUpdateInput");
    expect(mapper).toContain('    org: meta?.org ?? "",\n');
  });
});
