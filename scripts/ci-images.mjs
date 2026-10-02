/**
 * No job the merge queue waits on pulls from Docker Hub alone.
 *
 * Docker Hub's token endpoint once answered 500 for a few seconds, and a gate
 * run failed in `docker compose build` before any test ran, on a change that
 * touched none of it (#1705). The gate's pulls therefore come through Google's
 * public mirror of Docker Hub, with Hub kept as the fallback, and this module
 * refuses the two ways a workflow file can go back to Hub alone:
 *
 *   - A service or job container that names a Docker Hub image. GitHub pulls
 *     `services:` and `container:` in "Initialize containers", before any
 *     step, so no step can give that pull a mirror; the reference itself must
 *     name one (`mirror.gcr.io/library/postgres:16`). A reference is Docker
 *     Hub's as Docker resolves it: one with no `/` (`postgres:16`), one whose
 *     part before the first `/` has no `.` or `:` and is not `localhost`
 *     (`temporalio/auto-setup:1.28.0`), or one whose host is Docker Hub's own.
 *     A reference built from an expression cannot be judged from the file and
 *     is refused too.
 *   - A step that runs `docker` or `kind` before the job has called
 *     .github/actions/docker-hub-mirror, which gives the runner's dockerd the
 *     mirror (its header holds the reasons). A command at a line's start or
 *     after `&&`, `||`, `;`, `|` or `$(` counts, with or without `sudo`.
 *     Pulls a step starts through `make` or a script are seen at run time
 *     instead: in the gate, test/install/lib/docker-hub-mirror.mjs refuses to
 *     pull when dockerd lists no mirror.
 *
 * The set judged is scripts/ci-timeouts.mjs's: every workflow that runs on
 * `merge_group` and every workflow those call. A call that cannot be followed
 * is that module's finding and is not repeated here.
 *
 * Pure: it reads parsed workflow documents, `[{ file, doc }]`, and returns
 * findings as sentences; scripts/ci-images.test.mjs runs it over
 * .github/workflows and over fixtures of each drift.
 */

import { queueWorkflows } from "./ci-timeouts.mjs";

/** The action a job calls before any step that runs docker or kind. */
export const MIRROR_ACTION = "./.github/actions/docker-hub-mirror";

const DOCKER_HUB_HOSTS = new Set(["docker.io", "index.docker.io", "registry-1.docker.io"]);

/** A `docker` or `kind` command: at a line's start or after a shell separator, `sudo` allowed. */
const DOCKER_COMMAND = /(?:^|&&|\|\||;|\||\$\()\s*(?:sudo\s+)?(docker|kind)(?=\s|$)/m;

/** Whether `reference` names an image Docker would pull from Docker Hub. */
export function isDockerHub(reference) {
  const slash = reference.indexOf("/");
  if (slash === -1) return true;
  const host = reference.slice(0, slash);
  if (DOCKER_HUB_HOSTS.has(host)) return true;
  return !host.includes(".") && !host.includes(":") && host !== "localhost";
}

/** The `docker` or `kind` command a `run:` script starts, or undefined. */
export function dockerCommand(script) {
  return DOCKER_COMMAND.exec(String(script))?.[1];
}

function imageOf(container) {
  return typeof container === "string" ? container : container?.image;
}

/**
 * What the rule judges in the queue's workflows: each container reference
 * (`{ at, image }`) and each step that runs docker or kind (`{ at, command,
 * mirrored }`).
 */
export function judged(workflows) {
  const { reached } = queueWorkflows(workflows);
  const byFile = new Map(workflows.map((workflow) => [workflow.file, workflow]));
  const images = [];
  const commands = [];
  for (const file of reached) {
    for (const [job, def] of Object.entries(byFile.get(file).doc?.jobs ?? {})) {
      const at = `${file} ${job}`;
      if (def?.container !== undefined) images.push({ at: `${at} container`, image: imageOf(def.container) });
      for (const [name, service] of Object.entries(def?.services ?? {})) {
        images.push({ at: `${at} services.${name}`, image: imageOf(service) });
      }
      let mirrored = false;
      (def?.steps ?? []).forEach((step, index) => {
        if (step?.uses === MIRROR_ACTION) mirrored = true;
        const command = step?.run === undefined ? undefined : dockerCommand(step.run);
        if (command !== undefined) {
          commands.push({ at: `${at} step ${index + 1} ("${step.name ?? "unnamed"}")`, command, mirrored });
        }
      });
    }
  }
  return { images, commands };
}

/** Why a job the merge queue waits on could pull from Docker Hub alone; empty when none could. */
export function imageFindings(workflows) {
  const { images, commands } = judged(workflows);
  const findings = [];
  for (const { at, image } of images) {
    if (typeof image !== "string" || image === "") {
      findings.push(`${at} names no image this rule can read`);
    } else if (image.includes("${{")) {
      findings.push(`${at}: \`${image}\` is an expression, so whether it pulls from Docker Hub cannot be judged from the file; name the image`);
    } else if (isDockerHub(image)) {
      const bare = image.replace(/^(docker\.io|index\.docker\.io|registry-1\.docker\.io)\//, "");
      const path = bare.includes("/") ? bare : `library/${bare}`;
      findings.push(
        `${at}: \`${image}\` is pulled from Docker Hub before any step runs, so no mirror can reach it; name \`mirror.gcr.io/${path}\` (${MIRROR_ACTION}/docker-hub-mirror.mjs's header says why)`,
      );
    }
  }
  for (const { at, command, mirrored } of commands) {
    if (!mirrored) {
      findings.push(`${at} runs \`${command}\` before the job calls ${MIRROR_ACTION}; call it in an earlier step so dockerd pulls Docker Hub images through the mirror`);
    }
  }
  return findings;
}
