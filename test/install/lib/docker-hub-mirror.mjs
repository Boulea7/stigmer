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
 *   - Base images pulled before a build, not left to BuildKit. dockerd takes a
 *     mirror on its SIGHUP reload for `docker pull`, `docker run` and
 *     `compose up`, but BuildKit, which resolves a build's `FROM` and
 *     `COPY --from` images, takes mirrors only when dockerd starts (measured on
 *     Docker 28.0.4, the runners' version: a reloaded mirror left every build
 *     going to Hub, and one set at start was used). Restarting dockerd would
 *     stop a job's service containers. So before a source build, every image
 *     its Dockerfiles build on is pulled through dockerd, and BuildKit builds
 *     from those local copies. The list is read from the Dockerfiles, not
 *     kept: each `FROM`, `COPY --from` and `RUN --mount ... from=` reference
 *     that is not one of the file's own stages.
 *   - kind follows the host. kind's nodes run their own containerd, which the
 *     host daemon's mirrors never reach. When dockerd lists a mirror, the
 *     cluster is created with containerd's own hosts.toml for docker.io (kind's
 *     documented `config_path` mechanism, mounted at creation): each mirror
 *     first, Docker Hub as the fallback. With no mirror, kind is created
 *     exactly as before.
 *
 * Plain node and the docker CLI, no dependencies, like its neighbours.
 * docker-hub-mirror.test.mjs pins the reader against a fake `docker`, the
 * Dockerfile reader against fixtures and the gate's own Dockerfiles, and the
 * kind config against its exact text.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import process from "node:process";

/** The action a gate job calls before it reaches Docker. */
export const MIRROR_ACTION = "./.github/actions/docker-hub-mirror";

/** Where containerd looks for per-registry hosts files inside a kind node. */
const NODE_CERTS_DIR = "/etc/containerd/certs.d";

/** The one image name a Dockerfile can build on that is not pulled. */
const EMPTY_BASE = "scratch";

/** `docker info` answering slower than this is a daemon that is not there. */
const DOCKER_INFO_TIMEOUT_MS = 30_000;

/** One base image's pull; the largest, golang:1.25-bookworm, is about 300 MB. */
const PULL_TIMEOUT_MS = 10 * 60 * 1000;

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

/**
 * The images a Dockerfile builds on from a registry, in the order it names
 * them: every `FROM`, `COPY --from=` and `RUN --mount=...,from=` reference
 * that is not a stage the file itself defines (stage names are matched as
 * Docker matches them, without case), and not `scratch`. A reference built
 * from an `ARG` cannot be read from the file and is refused, named with its
 * line, so a pull can never be skipped by a build argument.
 */
export function dockerfileBaseImages(text, file = "Dockerfile") {
  const stages = new Set();
  const images = [];
  const add = (reference, line) => {
    if (reference.includes("$")) {
      throw new Error(`${file}:${line}: \`${reference}\` is built from an ARG, so the image it pulls cannot be read from the file`);
    }
    const lower = reference.toLowerCase();
    if (stages.has(lower) || lower === EMPTY_BASE || images.includes(reference)) return;
    images.push(reference);
  };
  text.split("\n").forEach((raw, index) => {
    const line = index + 1;
    const from = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?\s*$/i.exec(raw);
    if (from) {
      add(from[1], line);
      if (from[2] !== undefined) stages.add(from[2].toLowerCase());
      return;
    }
    if (/^\s*COPY\b/i.test(raw)) {
      const copied = /\s--from=(\S+)/i.exec(raw);
      if (copied) add(copied[1], line);
      return;
    }
    if (/^\s*RUN\b/i.test(raw)) {
      for (const mount of raw.matchAll(/--mount=(\S+)/gi)) {
        const mounted = /(?:^|,)from=([^,\s]+)/i.exec(mount[1]);
        if (mounted) add(mounted[1], line);
      }
    }
  });
  return images;
}

/**
 * When dockerd lists a Docker Hub mirror, pull every image `dockerfiles`
 * build on through it, so BuildKit, which does not take a mirror dockerd got
 * on reload, finds each one local. With no mirror nothing is pulled, and the
 * build resolves its images as it always did. Returns the images pulled.
 */
export function pullBaseImages(dockerfiles, { log }) {
  if (dockerHubMirrors().length === 0) return [];
  const images = [];
  for (const file of dockerfiles) {
    for (const image of dockerfileBaseImages(readFileSync(file, "utf8"), relative(process.cwd(), file) || file)) {
      if (!images.includes(image)) images.push(image);
    }
  }
  log(`pulling ${images.join(", ")} through dockerd's Docker Hub mirror (BuildKit does not take a reloaded one)`);
  for (const image of images) {
    execFileSync("docker", ["pull", "--quiet", image], { stdio: ["ignore", "ignore", "inherit"], timeout: PULL_TIMEOUT_MS });
  }
  return images;
}
