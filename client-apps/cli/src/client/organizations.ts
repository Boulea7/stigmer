// Which organization a value names, for the commands that compare two of
// them or print one.
//
// An organization is filed under a permanent id and named by a slug that
// can change. A person types either (`--org acme`, `org: acme` in a
// manifest), the server stores and answers the id, and an older slug keeps
// leading to its organization for a while after a rename. So two values
// that differ as strings may still name one organization: `acme` and
// `org_01j9…`, or a slug and the one it was renamed from. These helpers ask
// the server, which resolves every form, and only when the strings differ.
//
// A value the caller cannot see answers undefined, so a comparison treats
// it as a different organization and the server judges the request.
import type { Stigmer } from "@stigmer/sdk";

/** An organization as people and the server name it. */
export interface OrganizationNames {
  readonly id: string;
  readonly slug: string;
}

/** The organization a value (id or slug) names, or undefined when the caller cannot see one by it. */
export async function organizationNamed(
  stigmer: Stigmer,
  value: string,
): Promise<OrganizationNames | undefined> {
  if (value === "") return undefined;
  try {
    const organization = await stigmer.organization.get(value);
    const id = organization.metadata?.id ?? "";
    return id === "" ? undefined : { id, slug: organization.metadata?.slug ?? "" };
  } catch {
    return undefined;
  }
}

/** Whether two values (ids or slugs) name the same organization. */
export async function sameOrganization(
  stigmer: Stigmer,
  a: string,
  b: string,
): Promise<boolean> {
  if (a === b) return true;
  const [first, second] = await Promise.all([
    organizationNamed(stigmer, a),
    organizationNamed(stigmer, b),
  ]);
  return first !== undefined && second !== undefined && first.id === second.id;
}

/** How output names an organization: its slug when the caller can see it, else the value as given. */
export async function organizationLabel(
  stigmer: Stigmer,
  value: string,
): Promise<string> {
  return (await organizationNamed(stigmer, value))?.slug || value;
}

/**
 * Labels for many organization values at once, one lookup per distinct
 * non-empty value however many rows carry it. A value missing from the
 * answer prints as given.
 */
export async function organizationLabels(
  stigmer: Stigmer,
  values: Iterable<string>,
): Promise<ReadonlyMap<string, string>> {
  const distinct = [...new Set(values)].filter((value) => value !== "");
  const labels = await Promise.all(distinct.map((value) => organizationLabel(stigmer, value)));
  return new Map(distinct.map((value, index) => [value, labels[index] ?? value]));
}
