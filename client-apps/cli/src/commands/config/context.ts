// `stigmer config context show|set` — the active CLI context: the
// organization every command targets when neither `--org` nor
// STIGMER_ORG names one.
//
// `set --org <slug|id>` checks the value against the active backend before
// it persists: the organization must be one the caller belongs to there
// (findMyOrganizations, matched by slug or id), so a typo or a stranger's
// organization is refused at the moment it is typed, not on the next
// command. It stores the organization's id, which never changes, and its
// slug for output: a context set before the organization is renamed keeps
// working after it. An empty value clears the context without asking the
// backend. The raw `config set context.org` stays the unchecked escape
// hatch.

import type { Command } from "commander";
import { type Config, activeBackendName, contextOrganizationLabel, ensureAuthenticated, load, save } from "../../config/index.js";
import { CliExitError, ExitCode, UsageError } from "../../errors/index.js";
import { CommandResult, type OutputFlags, renderResult } from "../../output/index.js";
import { addResultFlags, resultFormat } from "../shared.js";

export function addContextCommands(context: Command): void {
  const show = context
    .command("show")
    .description("show the active context")
    .action((options: OutputFlags) => {
      renderResult(buildShow(load()), resultFormat(options));
    });
  addResultFlags(show);

  const set = context
    .command("set")
    .description("set the active context's organization, checked against the backend")
    .option("--org <slug>", "an organization you belong to on the active backend, by slug or id (empty clears it)")
    .action((options: OutputFlags & { org?: string }) => runSet(options));
  addResultFlags(set);
}

function buildShow(config: Config): CommandResult {
  const organization = contextOrganizationLabel(config) || "(not set)";
  const result = CommandResult.success("CLI context");
  result.addSection("").field("Organization", organization).field("Backend", activeBackendName(config));
  return result;
}

async function runSet(flags: OutputFlags & { org?: string }): Promise<void> {
  const org = flags.org;
  if (org === undefined) {
    throw new UsageError(
      "--org is required\n\nSet it with:\n  stigmer config context set --org <org>\nClear it with:\n  stigmer config context set --org \"\"",
    );
  }

  const config = load();
  const context = (config.context ??= {});
  if (org === "") {
    delete context.org;
    delete context.org_slug;
    save(config);
    renderResult(CommandResult.success("Context organization cleared"), resultFormat(flags));
    return;
  }
  const membership = await assertMembership(config, org);
  context.org = membership.id;
  context.org_slug = membership.slug;
  save(config);
  renderResult(CommandResult.success(`Context organization set to '${membership.slug}'`), resultFormat(flags));
}

async function assertMembership(config: Config, org: string): Promise<{ id: string; slug: string }> {
  const { connectBackend } = await import("../../backend.js");
  const client = connectBackend(config);
  ensureAuthenticated(client.config);
  const mine = await client.stigmer.organization.findMyOrganizations();
  const match = mine.entries.find((entry) => entry.metadata?.slug === org || entry.metadata?.id === org);
  if (match?.metadata !== undefined && match.metadata.id !== "") {
    return { id: match.metadata.id, slug: match.metadata.slug };
  }
  throw new CliExitError(
    `organization '${org}' is not one you belong to on the '${activeBackendName(config)}' backend`,
    ExitCode.NotFound,
    ["See the organizations you belong to with: stigmer list organizations"],
  );
}
