// Tests for scripts/ci-images.mjs: no job the merge queue waits on pulls from Docker Hub alone.
// Run via `node --test scripts/ci-images.test.mjs` (wired into root `npm test`).
//
// What these guard: a service or job container naming a Docker Hub image is
// pulled before any step, where no mirror can reach it, and a step that runs
// docker or kind before the mirror action pulls from Hub alone. Either fails a
// gate run whenever Hub's token endpoint does (#1705). The real workflows are
// read as they are and pinned as not vacuous: the rule judges today's five
// container references and the two `kind version` steps, all through the
// mirror. Fixtures pin each reference spelling Docker resolves to Hub (bare,
// namespaced, explicit docker.io) and the ones it does not (another host, a
// port, localhost); an expression; each command position (a line's start,
// after `&&`, `||`, `;`, `|`, `$(`, with `sudo`) and the words that are not a
// command; and a mirror step after the command, which does not count.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

import { MIRROR_ACTION, dockerCommand, imageFindings, isDockerHub, judged } from "./ci-images.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflowsDir = join(root, ".github/workflows");
const workflows = readdirSync(workflowsDir)
  .filter((file) => file.endsWith(".yaml") || file.endsWith(".yml"))
  .map((file) => ({ file, doc: parse(readFileSync(join(workflowsDir, file), "utf8")) }));

const MIRROR_STEP = { name: "Docker Hub through a mirror", uses: MIRROR_ACTION };

/** A queue root (`on: merge_group`) with the given jobs. */
function fixture(jobs) {
  return [{ file: "ci.root.yaml", doc: { on: { merge_group: null }, jobs } }];
}

test("no job the merge queue waits on pulls from Docker Hub alone", () => {
  assert.deepEqual(imageFindings(workflows), []);
});

test("the rule judges today's five container references and two kind steps, so the check above is not vacuous", () => {
  const { images, commands } = judged(workflows);
  assert.deepEqual(images.map(({ at }) => at).sort(), [
    "ci.conformance-execution.yaml conformance-execution-local-postgres services.postgres",
    "ci.conformance.yaml conformance-local-postgres services.postgres",
    "ci.install-script.yaml install-linux container",
    "ci.stigmer-server.yaml server services.postgres",
    "ci.stigmer-server.yaml server-tests services.postgres",
  ]);
  assert.ok(images.every(({ image }) => image.startsWith("mirror.gcr.io/")), JSON.stringify(images));
  assert.deepEqual(
    commands.map(({ at, command, mirrored }) => [at.split(" step ")[0], command, mirrored]).sort(),
    [
      ["ci.helm-chart.yaml kind-gate", "kind", true],
      ["ci.upgrade-rehearsal.yaml rehearse", "kind", true],
    ],
  );
});

test("Docker resolves bare, namespaced and explicit docker.io references to Hub, and the rest elsewhere", () => {
  for (const reference of ["postgres:16", "ubuntu", "temporalio/auto-setup:1.28.0", "docker.io/library/postgres:16", "index.docker.io/x/y"]) {
    assert.equal(isDockerHub(reference), true, reference);
  }
  for (const reference of ["mirror.gcr.io/library/postgres:16", "ghcr.io/stigmer/stigmer:v1", "localhost/x:1", "registry:5000/x", "public.ecr.aws/docker/library/node:22"]) {
    assert.equal(isDockerHub(reference), false, reference);
  }
});

test("a Hub service or job container is refused, named, with the mirror spelling to use", () => {
  const findings = imageFindings(
    fixture({
      a: { services: { db: { image: "postgres:16" } }, steps: [] },
      b: { container: "temporalio/auto-setup:1.28.0", steps: [] },
      c: { container: { image: "docker.io/library/ubuntu:24.04" }, steps: [] },
      ok: { services: { db: { image: "mirror.gcr.io/library/postgres:16" } }, container: "ghcr.io/stigmer/x:1", steps: [] },
    }),
  );
  assert.equal(findings.length, 3, findings.join("\n"));
  assert.match(findings[0], /ci\.root\.yaml a services\.db: `postgres:16` .* name `mirror\.gcr\.io\/library\/postgres:16`/);
  assert.match(findings[1], /ci\.root\.yaml b container: .* name `mirror\.gcr\.io\/temporalio\/auto-setup:1\.28\.0`/);
  assert.match(findings[2], /ci\.root\.yaml c container: .* name `mirror\.gcr\.io\/library\/ubuntu:24\.04`/);
});

test("an image built from an expression, or none at all, is refused: it cannot be judged from the file", () => {
  const findings = imageFindings(fixture({ a: { container: "${{ matrix.image }}", services: { db: {} }, steps: [] } }));
  assert.equal(findings.length, 2, findings.join("\n"));
  assert.match(findings[0], /is an expression/);
  assert.match(findings[1], /names no image this rule can read/);
});

test("docker or kind is a command at a line's start and after each separator, with or without sudo", () => {
  for (const script of ["docker build .", "set -e\nkind create cluster", "a && docker pull x", "a || kind load", "a; docker run x", "a | docker load", "x=$(docker info)", "sudo docker pull x", "kind"]) {
    assert.ok(dockerCommand(script), script);
  }
  for (const script of ["curl -o /tmp/kind https://kind.sigs.k8s.io/dl/v0.24.0/kind-linux-amd64", "echo docker-compose", "make smoke-compose", "sudo install -m 0755 /tmp/kind /usr/local/bin/kind", "dockerd --help"]) {
    assert.equal(dockerCommand(script), undefined, script);
  }
});

test("a step that runs docker or kind before the mirror action is refused, and after it passes", () => {
  const before = imageFindings(fixture({ a: { steps: [{ name: "pull", run: "docker pull alpine" }, MIRROR_STEP] } }));
  assert.equal(before.length, 1, before.join("\n"));
  assert.match(before[0], /ci\.root\.yaml a step 1 \("pull"\) runs `docker` before the job calls \.\/\.github\/actions\/docker-hub-mirror/);
  assert.deepEqual(imageFindings(fixture({ a: { steps: [MIRROR_STEP, { name: "pull", run: "docker pull alpine" }] } })), []);
});

test("a workflow the merge queue does not wait on is not judged", () => {
  const outside = [{ file: "release.x.yaml", doc: { on: { push: null }, jobs: { a: { container: "postgres:16", steps: [{ run: "docker build ." }] } } } }];
  assert.deepEqual(imageFindings(outside), []);
});
