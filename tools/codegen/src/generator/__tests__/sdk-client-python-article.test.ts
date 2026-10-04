/**
 * Pins how the Python SDK generator names a resource in its input's prose:
 * with the article the name takes ("an Organization", "a Skill"), in the
 * input's docstring and, for an organization-less kind, in the comment on
 * its always-empty organization.
 *
 * The generator runs over the real schemas into a temporary directory, and
 * these cases read what it wrote.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runSDKClientPythonGeneration } from "../sdk-client-python.js";

const SCHEMAS = path.resolve(__dirname, "../../../schemas");

describe("the Python SDK's inputs name their resource with its article", () => {
  let root: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "codegen-python-article-"));
    runSDKClientPythonGeneration(SCHEMAS, root);
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("an organization's input says an Organization, in its docstring and its organization comment", () => {
    const source = fs.readFileSync(path.join(root, "_organization.py"), "utf8");
    expect(source).toContain('    """Input for creating or updating an Organization."""\n');
    expect(source).toContain("    # Always empty: an Organization belongs to no organization.\n");
    expect(source).not.toContain("a Organization");
  });

  it("a kind whose name starts with a consonant keeps a", () => {
    const source = fs.readFileSync(path.join(root, "_skill.py"), "utf8");
    expect(source).toContain('    """Input for creating or updating a Skill."""\n');
  });
});
