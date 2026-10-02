/**
 * Points the runner's dockerd at Google's public mirror of Docker Hub, with Hub
 * kept as the fallback, without restarting it, and proves the daemon took it.
 *
 * Every gate job that builds the product's images or starts its stack pulls
 * Docker Hub images (the Dockerfiles' bases, compose's Postgres and Temporal,
 * kind's node), anonymously and from Hub alone. When Hub's token endpoint
 * failed for a few seconds, `docker compose build` failed before any test ran
 * and a gate run went red on a change that touched none of it (#1705). With
 * the mirror set, dockerd asks mirror.gcr.io first and Docker Hub after it,
 * for `docker pull`, `docker run`, `compose up` and every BuildKit resolve
 * (`FROM` and `COPY --from`) alike, so a pull fails only when both are down.
 *
 * The trade-offs:
 *   - Google's mirror, not one of our own. dockerd takes a mirror for
 *     docker.io only as a bare host, so a copy under ghcr.io/stigmer/... could
 *     only be reached by rewriting every reference, including those in the old
 *     releases the upgrade rehearsals install first. mirror.gcr.io serves
 *     every image the gate pulls, for amd64 and arm64, at Hub's digests
 *     (measured 2026-10-02). AWS's public copy lacks temporalio/auto-setup.
 *   - A source added, none removed. Hub stays in dockerd's list after the
 *     mirror, so an image the mirror lacks still comes from Hub.
 *   - A reload, never a restart. A job's service containers (Server Gate's
 *     Postgres, which its image smoke reaches) run under this dockerd and
 *     would die with it. dockerd reloads `registry-mirrors` on SIGHUP, the
 *     signal its systemd unit's own reload sends, and reads a daemon.json
 *     created after it started.
 *   - No retry. The daemon either lists the mirror within the deadline or the
 *     step fails, named, once.
 *
 * Service and job containers are pulled before any step runs, so nothing here
 * reaches them; their references name mirror.gcr.io directly, and
 * scripts/ci-images.mjs refuses one that names Docker Hub.
 * test/install/lib/docker-hub-mirror.mjs reads what dockerd lists: the gate's
 * install scripts refuse to pull without it, and kind's nodes get the same
 * mirrors. docker-hub-mirror.test.mjs pins the merge and the whole sequence
 * against a fake dockerd.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** Google's public mirror of Docker Hub. */
export const MIRROR = "https://mirror.gcr.io";

/** How long dockerd has to list the mirror after the reload; it takes well under a second. */
export const DEADLINE_MS = 30_000;

const POLL_MS = 250;

/**
 * `config` (a parsed daemon.json) with MIRROR first in `registry-mirrors`,
 * every other key and mirror kept. A config that already lists it is returned
 * unchanged.
 */
export function withMirror(config) {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`docker-hub-mirror: daemon.json holds ${JSON.stringify(config)}, not a JSON object; refusing to rewrite it`);
  }
  const current = config["registry-mirrors"] ?? [];
  if (!Array.isArray(current)) {
    throw new Error(`docker-hub-mirror: daemon.json's registry-mirrors is ${JSON.stringify(current)}, not a list; refusing to rewrite it`);
  }
  const bare = (url) => String(url).replace(/\/+$/, "");
  if (current.some((url) => bare(url) === MIRROR)) return config;
  return { ...config, "registry-mirrors": [MIRROR, ...current] };
}

/** The mirrors `docker info` prints, without the trailing slash dockerd adds; `null` is none. */
export function listedMirrors(printed) {
  const value = JSON.parse(printed.trim());
  if (value === null) return [];
  return value.map((url) => String(url).replace(/\/+$/, ""));
}

/** Runs `command` as root: directly when this process is root, through sudo otherwise. */
function asRoot(command, args, options = {}) {
  const [file, argv] = process.getuid?.() === 0 ? [command, args] : ["sudo", [command, ...args]];
  return execFileSync(file, argv, { encoding: "utf8", ...options });
}

function readConfig(daemonJson) {
  if (!existsSync(daemonJson)) return {};
  const text = readFileSync(daemonJson, "utf8");
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`docker-hub-mirror: ${daemonJson} is not JSON (${error.message}); refusing to rewrite it`);
  }
}

function mirrorsNow() {
  const info = spawnSync("docker", ["info", "--format", "{{json .RegistryConfig.Mirrors}}"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (info.status !== 0) return [];
  try {
    return listedMirrors(info.stdout);
  } catch {
    return [];
  }
}

/**
 * Writes MIRROR into `daemonJson`, sends dockerd (the pid in `pidfile`) SIGHUP,
 * and waits until `docker info` lists it. Throws, named, when it does not.
 */
export async function configure({
  daemonJson = "/etc/docker/daemon.json",
  pidfile = "/var/run/docker.pid",
  deadlineMs = DEADLINE_MS,
  log = console.log,
} = {}) {
  const config = withMirror(readConfig(daemonJson));
  asRoot("mkdir", ["-p", dirname(daemonJson)]);
  asRoot("tee", [daemonJson], { input: `${JSON.stringify(config, null, 2)}\n`, stdio: ["pipe", "ignore", "inherit"] });
  if (!existsSync(pidfile)) throw new Error(`docker-hub-mirror: no ${pidfile}, so dockerd cannot be told to reload`);
  const pid = readFileSync(pidfile, "utf8").trim();
  if (!/^\d+$/.test(pid)) throw new Error(`docker-hub-mirror: ${pidfile} holds ${JSON.stringify(pid)}, not a pid`);
  asRoot("kill", ["-HUP", pid]);
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const mirrors = mirrorsNow();
    if (mirrors.includes(MIRROR)) {
      log(`docker-hub-mirror: dockerd lists ${mirrors.join(", ")}, then Docker Hub`);
      return mirrors;
    }
    if (Date.now() >= deadline) {
      throw new Error(`docker-hub-mirror: dockerd did not take ${MIRROR} within ${deadlineMs / 1000} s (it lists ${JSON.stringify(mirrors)})`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await configure();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
