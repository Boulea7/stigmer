/**
 * How the install layer meets Docker Hub: the mirrors dockerd lists, the gate's
 * refusal to pull without one, and the same mirrors handed to kind's nodes.
 *
 * Every image these scripts build on or start is a Docker Hub image (the
 * Dockerfiles' bases, compose's Postgres and Temporal, kind's node, the chart's
 * Postgres and Temporal), and the compose file and chart a user installs name
 * them as Docker Hub names. An anonymous pull fails when Hub's token endpoint
 * does, which once turned a gate run red on a change that touched none of this
 * (#1705: `auth.docker.io/token` answered 500 during `docker compose build`).
 *
 * In the gate the runner's dockerd lists Google's public mirror of Docker Hub,
 * set by .github/actions/docker-hub-mirror, and dockerd tries it before Hub. So
 * a gate pull fails only when both are down. Nothing here names the mirror:
 * dockerd's own list (`docker info`) is the one source of truth, so the gate
 * check and kind's nodes cannot disagree with the daemon.
 *
 * The trade-offs:
 *   - A refusal in the gate, not a silent pull from Hub alone. A gate job that
 *     reaches Docker without the action is a job the next Hub outage fails, and
 *     nobody notices until then. So in the gate (STIGMER_TEST_GATE=1, which
 *     every lane sets, on GitHub Actions) an empty list throws, naming the
 *     action. The release runs these scripts without the flag, and a
 *     developer's machine is not GitHub Actions, so neither is refused.
 *   - Names unchanged. A daemon mirror serves `postgres:16` as `postgres:16`,
 *     so what users install is what the gate runs, and nothing that reads an
 *     image's name (the rehearsal's serviceImages) sees a difference.
 *   - kind follows the host. kind's nodes run their own containerd, which the
 *     host daemon's mirrors never reach. When dockerd lists a mirror, the
 *     cluster is created with containerd's own hosts.toml for docker.io (kind's
 *     documented `config_path` mechanism, mounted at creation): each mirror
 *     first, Docker Hub as the fallback. With no mirror, kind is created
 *     exactly as before.
 *
 * Plain node and the docker CLI, no dependencies, like its neighbours.
 * docker-hub-mirror.test.mjs pins the reader against a fake `docker` and the
 * kind config against its exact text.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

/** The action a gate job calls before it reaches Docker. */
export const MIRROR_ACTION = "./.github/actions/docker-hub-mirror";

/** Where containerd looks for per-registry hosts files inside a kind node. */
const NODE_CERTS_DIR = "/etc/containerd/certs.d";

/** `docker info` answering slower than this is a daemon that is not there. */
const DOCKER_INFO_TIMEOUT_MS = 30_000;

let cached;

/**
 * The mirrors dockerd lists for Docker Hub, without the trailing slash it adds,
 * read once per process. A daemon with none prints `null`. A `docker info`
 * that fails, or prints something other than a list, throws, named.
 */
export function dockerHubMirrors() {
  if (cached !== undefined) return cached;
  let printed;
  try {
    printed = execFileSync("docker", ["info", "--format", "{{json .RegistryConfig.Mirrors}}"], {
      encoding: "utf8",
      timeout: DOCKER_INFO_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const said = String(error.stderr ?? "").trim() || error.message;
    throw new Error(`docker-hub-mirror: \`docker info\` failed, so the mirrors dockerd uses are unknown: ${said}`);
  }
  cached = parseMirrors(printed);
  return cached;
}

/** `docker info`'s mirror list as printed: a JSON array of URLs, or `null` for none. */
export function parseMirrors(printed) {
  const text = printed.trim();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    value = undefined;
  }
  if (value === null) return [];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`docker-hub-mirror: \`docker info\` printed ${JSON.stringify(text)} for the registry mirrors, not a list`);
  }
  return value.map((url) => url.replace(/\/+$/, ""));
}

/**
 * In the gate, refuse to go on when dockerd lists no Docker Hub mirror. Called
 * before the first pull of every script that pulls a Docker Hub image.
 * Outside the gate it returns at once.
 */
export function assertDockerHubMirror(env = process.env) {
  if (env.STIGMER_TEST_GATE !== "1" || env.GITHUB_ACTIONS !== "true") return;
  if (dockerHubMirrors().length > 0) return;
  throw new Error(
    `docker-hub-mirror: this job pulls from Docker Hub with no mirror; call ${MIRROR_ACTION} first (the gate provides every dependency)`,
  );
}

/**
 * The two files a kind cluster needs to pull Docker Hub images through
 * `mirrors`: containerd's hosts.toml for docker.io (each mirror, then Hub),
 * and the cluster config that points containerd at it and mounts it into the
 * node. `hostDir` is where the hosts file lives on this machine.
 */
export function kindRegistryConfig(mirrors, hostDir) {
  if (mirrors.length === 0) throw new Error("kindRegistryConfig needs at least one mirror");
  const hostsToml = [
    'server = "https://registry-1.docker.io"',
    ...mirrors.flatMap((mirror) => ["", `[host."${mirror}"]`, '  capabilities = ["pull", "resolve"]']),
    "",
  ].join("\n");
  const clusterConfig = [
    "kind: Cluster",
    "apiVersion: kind.x-k8s.io/v1alpha4",
    "containerdConfigPatches:",
    "  - |-",
    '    [plugins."io.containerd.grpc.v1.cri".registry]',
    `      config_path = "${NODE_CERTS_DIR}"`,
    "nodes:",
    "  - role: control-plane",
    "    extraMounts:",
    `      - hostPath: ${JSON.stringify(hostDir)}`,
    `        containerPath: ${NODE_CERTS_DIR}`,
    "        readOnly: true",
    "",
  ].join("\n");
  return { hostsToml, clusterConfig };
}

/**
 * The `kind create cluster` arguments that carry dockerd's mirrors into the
 * node, written under `workDir`; none when dockerd lists no mirror.
 */
export function kindMirrorArgs(workDir) {
  const mirrors = dockerHubMirrors();
  if (mirrors.length === 0) return [];
  const hostDir = join(workDir, "certs.d");
  const { hostsToml, clusterConfig } = kindRegistryConfig(mirrors, hostDir);
  mkdirSync(join(hostDir, "docker.io"), { recursive: true });
  writeFileSync(join(hostDir, "docker.io", "hosts.toml"), hostsToml);
  const configFile = join(workDir, "kind-config.yaml");
  writeFileSync(configFile, clusterConfig);
  return ["--config", configFile];
}
