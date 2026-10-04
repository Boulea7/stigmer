/**
 * Pins how the Java SDK generator writes a resource input's organization into
 * its metadata. protobuf-java refuses a null string, and an input's `org` is
 * null whenever the caller leaves it out: always for an organization-less kind
 * (Organization, License, Plan), whose documented example sets none, and for
 * an organization-scoped kind on a server that fills the organization itself.
 * So `toProto()` sets the organization only when one was given.
 *
 * The generator runs over the real schemas into a temporary directory, and
 * these cases read what it wrote.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runSDKClientJavaGeneration } from "../sdk-client-java.js";

const SCHEMAS = path.resolve(__dirname, "../../../schemas");

describe("the Java SDK's inputs set an organization only when one was given", () => {
  let root: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "codegen-java-org-"));
    runSDKClientJavaGeneration(SCHEMAS, root);
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each(["OrganizationInput.java", "LicenseInput.java", "AgentInput.java"])(
    "%s guards a null organization",
    (file) => {
      const source = fs.readFileSync(path.join(root, file), "utf8");
      expect(source).toContain(
        "        ApiResourceMetadata.Builder metaBuilder = ApiResourceMetadata.newBuilder()\n" +
          "            .setName(this.name);\n" +
          "        if (this.org != null) {\n" +
          "            metaBuilder.setOrg(this.org);\n" +
          "        }\n",
      );
      expect(source).not.toContain(".setOrg(this.org);\n        if (this.id");
    },
  );
});
