// Tests for docker-hub-mirror.mjs: the daemon.json merge, and the write, reload and proof sequence against a fake dockerd.
// Run via `node --test .github/actions/docker-hub-mirror/docker-hub-mirror.test.mjs` (wired into root `npm test`).
//
// What these pin: the merge puts the mirror first and keeps every other key
// and mirror, changes nothing when the mirror is already there, and refuses a
// file it cannot read as a JSON object, rather than overwriting a runner's
// settings. The sequence is run whole, in a child process, against fakes first
// on PATH: `sudo` runs its arguments, and `docker info` prints what a fake
// dockerd last loaded. The fake dockerd is a real process whose pidfile the
// action reads. On SIGHUP it re-reads daemon.json, as dockerd does, so the
// case proves the action reloads the daemon rather than restarting it, and
// waits for what the daemon reports, not for what was written. A daemon that
// ignores the signal fails, named, within the deadline. Every case runs in
// about a second and needs nothing but Node and a shell, so it runs on a Mac
// and in the gate alike.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { MIRROR, listedMirrors, withMirror } from "./docker-hub-mirror.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "docker-hub-mirror.mjs");

// A dockerd stand-in: writes its pid once its SIGHUP handler is installed, and
// on each SIGHUP (unless deaf) records the mirrors daemon.json names, with
// the trailing slash the real daemon adds.
const FAKE_DOCKERD = `
import { readFileSync, writeFileSync } from "node:fs";
const [daemonJson, state, pidfile, mode] = process.argv.slice(2);
process.on("SIGHUP", () => {
  if (mode === "deaf") return;
  const mirrors = JSON.parse(readFileSync(daemonJson, "utf8"))["registry-mirrors"] ?? [];
  writeFileSync(state, JSON.stringify(mirrors.map((url) => url + "/")));
});
writeFileSync(pidfile, String(process.pid) + "\\n");
setInterval(() => {}, 1000);
`;

const FAKE_DOCKER = `#!/bin/sh
if [ "$1" = info ] && [ -f "$FAKE_DOCKER_STATE" ]; then cat "$FAKE_DOCKER_STATE"; elif [ "$1" = info ]; then echo null; else exit 64; fi
`;

const scratch = mkdtempSync(join(tmpdir(), "docker-hub-mirror-test-"));
let fixtureCount = 0;
const daemons = [];

afterEach(() => {
  for (const daemon of daemons.splice(0)) daemon.kill("SIGKILL");
});
after(() => rmSync(scratch, { recursive: true, force: true }));

function executable(path, body) {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

/** A fresh fixture: fakes on PATH, a running fake dockerd (deaf when asked), and daemon.json's path. */
async function fixture({ deaf = false, daemonJsonText } = {}) {
  const dir = join(scratch, String(++fixtureCount));
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  executable(join(bin, "sudo"), '#!/bin/sh\nexec "$@"\n');
  executable(join(bin, "docker"), FAKE_DOCKER);
  const daemonJson = join(dir, "etc", "docker", "daemon.json");
  if (daemonJsonText !== undefined) {
    mkdirSync(dirname(daemonJson), { recursive: true });
    writeFileSync(daemonJson, daemonJsonText);
  }
  const state = join(dir, "dockerd-state");
  const pidfile = join(dir, "docker.pid");
  writeFileSync(join(dir, "fake-dockerd.mjs"), FAKE_DOCKERD);
  const daemon = spawn(process.execPath, [join(dir, "fake-dockerd.mjs"), daemonJson, state, pidfile, deaf ? "deaf" : ""], {
    stdio: "ignore",
  });
  daemons.push(daemon);
  for (let waited = 0; !existsSync(pidfile); waited += 20) {
    if (waited > 5_000) throw new Error("the fake dockerd never wrote its pidfile");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return { dir, bin, daemonJson, state, pidfile };
}

/** Runs configure() in a child with the fixture's fakes first on PATH. */
function configure({ bin, daemonJson, pidfile }, { deadlineMs = 2_000 } = {}) {
  const call = `import { configure } from ${JSON.stringify(SCRIPT)};
try { await configure({ daemonJson: ${JSON.stringify(daemonJson)}, pidfile: ${JSON.stringify(pidfile)}, deadlineMs: ${deadlineMs} }); }
catch (error) { console.error(error.message); process.exit(1); }`;
  return spawnSync(process.execPath, ["--input-type=module", "-e", call], {
    encoding: "utf8",
    timeout: 10_000,
    killSignal: "SIGKILL",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_DOCKER_STATE: join(dirname(pidfile), "dockerd-state") },
  });
}

test("the mirror goes first, and every other key and mirror is kept", () => {
  const before = { "log-driver": "json-file", "registry-mirrors": ["https://example.internal"] };
  assert.deepEqual(withMirror(before), {
    "log-driver": "json-file",
    "registry-mirrors": [MIRROR, "https://example.internal"],
  });
  assert.deepEqual(withMirror({}), { "registry-mirrors": [MIRROR] });
});

test("a config that already lists the mirror, with or without its trailing slash, is returned unchanged", () => {
  for (const listed of [MIRROR, `${MIRROR}/`]) {
    const config = { "registry-mirrors": ["https://example.internal", listed] };
    assert.equal(withMirror(config), config);
  }
});

test("a daemon.json that is not a JSON object, or whose mirrors are not a list, is refused, not overwritten", () => {
  for (const config of [null, [], "x", 3]) {
    assert.throws(() => withMirror(config), /not a JSON object; refusing to rewrite it/);
  }
  assert.throws(() => withMirror({ "registry-mirrors": "https://mirror.gcr.io" }), /registry-mirrors is .* not a list/);
});

test("docker info's mirror list is read without the trailing slash, and null is none", () => {
  assert.deepEqual(listedMirrors("null\n"), []);
  assert.deepEqual(listedMirrors('["https://mirror.gcr.io/","https://example.internal/"]\n'), [
    "https://mirror.gcr.io",
    "https://example.internal",
  ]);
});

test("with no daemon.json, the action writes one, reloads dockerd by SIGHUP, and proves the daemon lists the mirror", async () => {
  const f = await fixture();
  const result = configure(f);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(f.daemonJson, "utf8")), { "registry-mirrors": [MIRROR] });
  assert.match(result.stdout, /docker-hub-mirror: dockerd lists https:\/\/mirror\.gcr\.io, then Docker Hub/);
  // The same daemon took the reload: a restart would have left no process behind this pid.
  assert.equal(daemons.at(-1).exitCode, null);
});

test("a runner's own daemon.json keys survive the rewrite", async () => {
  const f = await fixture({ daemonJsonText: '{ "exec-opts": ["native.cgroupdriver=cgroupfs"], "cgroup-parent": "/actions_job" }\n' });
  const result = configure(f);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(f.daemonJson, "utf8")), {
    "exec-opts": ["native.cgroupdriver=cgroupfs"],
    "cgroup-parent": "/actions_job",
    "registry-mirrors": [MIRROR],
  });
});

test("a daemon.json that is not JSON stops the action, named, and is left as it was", async () => {
  const f = await fixture({ daemonJsonText: "{ not json" });
  const result = configure(f);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /daemon\.json is not JSON .*refusing to rewrite it/);
  assert.equal(readFileSync(f.daemonJson, "utf8"), "{ not json");
});

test("a dockerd that does not take the mirror fails the action, named, at the deadline", async () => {
  const f = await fixture({ deaf: true });
  const started = Date.now();
  const result = configure(f, { deadlineMs: 600 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /dockerd did not take https:\/\/mirror\.gcr\.io within 0\.6 s \(it lists \[\]\)/);
  assert.ok(Date.now() - started < 5_000, "the deadline bounds the wait");
});

test("no pidfile stops the action, named, before anything waits", async () => {
  const f = await fixture();
  rmSync(f.pidfile);
  const result = configure(f);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no .*docker\.pid, so dockerd cannot be told to reload/);
});
