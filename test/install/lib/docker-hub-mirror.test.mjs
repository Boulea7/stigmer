// Tests for docker-hub-mirror.mjs: reading dockerd's mirrors, the gate's refusal without one, and kind's registry config.
// Run via `node --test test/install/lib/docker-hub-mirror.test.mjs` (wired into root `npm test`).
//
// What these pin: `docker info`'s list is read as dockerd prints it (`null`
// for none, URLs with a trailing slash), and anything else is refused by name
// rather than read as "no mirror". The refusal fires only in the gate (the
// flag every lane sets, on GitHub Actions), where it names the action to call.
// Outside it, `docker` is never asked, which the fake proves by failing if it
// is. kind's two files are pinned as exact text: containerd's hosts.toml (each
// mirror, then Docker Hub as `server`) and the cluster config that sets
// `config_path` and mounts the hosts directory. A cluster gets them only when
// dockerd lists a mirror. The process-level cases run in a child with a fake
// `docker` first on PATH, because the module reads dockerd once per process.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { MIRROR_ACTION, kindRegistryConfig, parseMirrors } from "./docker-hub-mirror.mjs";

const MODULE = join(dirname(fileURLToPath(import.meta.url)), "docker-hub-mirror.mjs");
// Real path: the child's process.cwd() resolves symlinks (/var is /private/var on macOS).
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "docker-hub-mirror-lib-test-")));
let fixtureCount = 0;
after(() => rmSync(scratch, { recursive: true, force: true }));

/**
 * Runs `body` (module code with the module's exports in scope) in a child
 * whose `docker info` prints `printed`, or exits 1 when `printed` is
 * undefined. `env` is the child's whole gate environment.
 */
function inChild(body, { printed, env = {} } = {}) {
  const dir = join(scratch, String(++fixtureCount));
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const answer = printed === undefined ? 'echo "Cannot connect to the Docker daemon" >&2; exit 1' : `printf '%s\\n' '${printed}'`;
  writeFileSync(join(bin, "docker"), `#!/bin/sh\necho called >> "${join(dir, "calls")}"\n${answer}\n`);
  chmodSync(join(bin, "docker"), 0o755);
  const script = `import * as m from ${JSON.stringify(MODULE)};
try { const out = await (async () => { ${body} })(); console.log(JSON.stringify(out ?? null)); }
catch (error) { console.error(error.message); process.exit(1); }`;
  const { STIGMER_TEST_GATE, GITHUB_ACTIONS, ...rest } = process.env;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    cwd: dir,
    timeout: 10_000,
    env: { ...rest, PATH: `${bin}:${process.env.PATH}`, ...env },
  });
  let calls = 0;
  try {
    calls = readFileSync(join(dir, "calls"), "utf8").trim().split("\n").length;
  } catch {
    calls = 0;
  }
  return { ...result, calls, dir };
}

const GATE = { STIGMER_TEST_GATE: "1", GITHUB_ACTIONS: "true" };

test("dockerd's list is read without trailing slashes, and null is no mirror", () => {
  assert.deepEqual(parseMirrors("null\n"), []);
  assert.deepEqual(parseMirrors('["https://mirror.gcr.io/"]\n'), ["https://mirror.gcr.io"]);
});

test("anything but a list of URLs is refused by name, never read as no mirror", () => {
  for (const printed of ["", "{}", "[1]", "<no value>"]) {
    assert.throws(() => parseMirrors(printed), /printed .* for the registry mirrors, not a list/);
  }
});

test("in the gate, a dockerd with no mirror is refused, naming the action", () => {
  const result = inChild("m.assertDockerHubMirror();", { printed: "null", env: GATE });
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`this job pulls from Docker Hub with no mirror; call ${MIRROR_ACTION.replaceAll(".", "\\.")} first`));
});

test("in the gate, a dockerd with the mirror passes, and docker is asked once per process", () => {
  const result = inChild("m.assertDockerHubMirror(); m.assertDockerHubMirror(); return m.dockerHubMirrors();", {
    printed: '["https://mirror.gcr.io/"]',
    env: GATE,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ["https://mirror.gcr.io"]);
  assert.equal(result.calls, 1);
});

test("outside the gate, or with the flag but off GitHub Actions, nothing is refused and docker is never asked", () => {
  for (const env of [{}, { STIGMER_TEST_GATE: "1" }, { GITHUB_ACTIONS: "true" }]) {
    const result = inChild("m.assertDockerHubMirror();", { env });
    assert.equal(result.status, 0, `${JSON.stringify(env)}: ${result.stderr}`);
    assert.equal(result.calls, 0, JSON.stringify(env));
  }
});

test("in the gate, a docker info that fails is a named failure, not a pass", () => {
  const result = inChild("m.assertDockerHubMirror();", { env: GATE });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /`docker info` failed, so the mirrors dockerd uses are unknown: Cannot connect to the Docker daemon/);
});

test("kind's hosts.toml lists each mirror, then Docker Hub as the server, and the config mounts it where containerd looks", () => {
  const { hostsToml, clusterConfig } = kindRegistryConfig(["https://mirror.gcr.io", "https://example.internal"], "/tmp/k/certs.d");
  assert.equal(
    hostsToml,
    [
      'server = "https://registry-1.docker.io"',
      "",
      '[host."https://mirror.gcr.io"]',
      '  capabilities = ["pull", "resolve"]',
      "",
      '[host."https://example.internal"]',
      '  capabilities = ["pull", "resolve"]',
      "",
    ].join("\n"),
  );
  assert.equal(
    clusterConfig,
    [
      "kind: Cluster",
      "apiVersion: kind.x-k8s.io/v1alpha4",
      "containerdConfigPatches:",
      "  - |-",
      '    [plugins."io.containerd.grpc.v1.cri".registry]',
      '      config_path = "/etc/containerd/certs.d"',
      "nodes:",
      "  - role: control-plane",
      "    extraMounts:",
      '      - hostPath: "/tmp/k/certs.d"',
      "        containerPath: /etc/containerd/certs.d",
      "        readOnly: true",
      "",
    ].join("\n"),
  );
  assert.throws(() => kindRegistryConfig([], "/tmp/k/certs.d"), /needs at least one mirror/);
});

test("a cluster gets the config only when dockerd lists a mirror, with the files written under its work dir", () => {
  const listed = inChild("return m.kindMirrorArgs(process.cwd());", { printed: '["https://mirror.gcr.io/"]' });
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout), ["--config", join(listed.dir, "kind-config.yaml")]);
  assert.match(readFileSync(join(listed.dir, "certs.d", "docker.io", "hosts.toml"), "utf8"), /\[host\."https:\/\/mirror\.gcr\.io"\]/);
  assert.match(readFileSync(join(listed.dir, "kind-config.yaml"), "utf8"), new RegExp(`hostPath: "${join(listed.dir, "certs.d")}"`));

  const none = inChild("return m.kindMirrorArgs(process.cwd());", { printed: "null" });
  assert.equal(none.status, 0, none.stderr);
  assert.deepEqual(JSON.parse(none.stdout), []);
});
