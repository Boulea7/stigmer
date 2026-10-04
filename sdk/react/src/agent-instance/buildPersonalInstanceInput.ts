import type { AgentInstanceInput, ResourceRef } from "@stigmer/sdk";
import { generateSlugSuffix } from "../internal/slug.js";

const PERSONAL_LABEL = "stigmer.ai/personal";
const FOR_AGENT_LABEL = "stigmer.ai/for-agent";

export interface PersonalInstanceParams {
  readonly org: string;
  readonly agentId: string;
  readonly agentSlug: string;
  readonly environmentRef: ResourceRef;
}

/**
 * The `stigmer.ai/for-agent` label a personal instance of `agentSlug` carries
 * in `org`, the organization the instance lives in (its id). Every lookup of a
 * personal instance builds its label here, so a lookup and the create it
 * guards always agree.
 */
export function personalInstanceAgentLabel(org: string, agentSlug: string): string {
  return `${org}/${agentSlug}`;
}

/**
 * Builds the {@link AgentInstanceInput} for creating a personal agent
 * instance. Centralizes the naming convention, unique slug generation,
 * and label assignment so that every call site produces consistent
 * personal instances.
 *
 * The slug includes a random suffix to guarantee uniqueness within
 * the org (multiple users can each have their own personal instance
 * for the same agent). Lookup is always label-based via FGA-scoped
 * list queries, so the slug is never used for retrieval.
 */
export function buildPersonalInstanceInput(
  params: PersonalInstanceParams,
): AgentInstanceInput {
  const { org, agentId, agentSlug, environmentRef } = params;
  return {
    name: `${agentSlug} Personal`,
    slug: `${agentSlug}-personal-${generateSlugSuffix()}`,
    org,
    agentId,
    labels: {
      [PERSONAL_LABEL]: "true",
      [FOR_AGENT_LABEL]: personalInstanceAgentLabel(org, agentSlug),
    },
    environmentRefs: [environmentRef],
  };
}
