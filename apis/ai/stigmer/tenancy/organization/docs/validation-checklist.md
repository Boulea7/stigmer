# Validation Checklist and Common Pitfalls

Pre-apply checklist and known pitfalls when authoring Organization YAML files.

## Pre-Apply Checklist

Run through this list before applying an Organization YAML with `stigmer org apply`.

### Required Fields

- [ ] `apiVersion` is exactly `tenancy.stigmer.ai/v1`
- [ ] `kind` is exactly `Organization`
- [ ] `metadata.name` is present
- [ ] `spec.description` clearly explains the organization's purpose (strongly recommended — organizations without descriptions render poorly in the UI)

### Slug Constraints

- [ ] `metadata.slug` (if set) is **2–15 characters** — shorter than most other resources
- [ ] `metadata.slug` contains only lowercase letters, numbers, and hyphens
- [ ] `metadata.slug` starts with a lowercase letter
- [ ] `metadata.slug` has no underscores or uppercase letters
- [ ] `metadata.slug` is not another organization's slug, or one another organization was renamed away from in the last 30 days

### Management Mode

- [ ] `spec.management_mode` is set intentionally — it is **immutable after creation**
- [ ] For `platform_managed`: `spec.identity_provider_ref` is present and references an existing, active IdentityProvider
- [ ] For `self_managed`: `spec.identity_provider_ref` is **absent** (must be empty)
- [ ] For `platform_managed`: `spec.external_org_id` is set to the platform's own org identifier

### Identity Provider Reference (platform_managed only)

- [ ] `identity_provider_ref.org` is a valid organization slug
- [ ] `identity_provider_ref.kind` is `identity_provider` (lowercase string)
- [ ] `identity_provider_ref.slug` matches an existing IdentityProvider slug

### YAML Syntax

- [ ] YAML is properly formatted and syntactically valid
- [ ] No trailing whitespace or tab characters in YAML values
- [ ] `spec.description` does not exceed 500 characters
- [ ] `spec.logo_url` does not exceed 2048 characters

## Common Pitfalls

### Slug too long

Organization slugs have a maximum of **15 characters** — much shorter than the 63-character limit on other resources like agents and skills.

```yaml
# Wrong — slug exceeds 15 characters
metadata:
  slug: my-engineering-org

# Correct
metadata:
  slug: my-eng-org
```

### Slug starts with a number

```yaml
# Wrong — must start with a lowercase letter
metadata:
  slug: 2acme

# Correct
metadata:
  slug: acme2
```

### Slug uses underscores

```yaml
# Wrong
metadata:
  slug: acme_corp

# Correct
metadata:
  slug: acme-corp
```

### Setting `identity_provider_ref` on a self-managed organization

For `self_managed` organizations, `identity_provider_ref` must be absent. Setting it will cause a validation error.

```yaml
# Wrong — self_managed cannot have identity_provider_ref
spec:
  management_mode: self_managed
  identity_provider_ref:
    org: stigmer
    kind: identity_provider
    slug: planton-idp

# Correct
spec:
  management_mode: self_managed
```

### Omitting `identity_provider_ref` for a platform-managed organization

When `management_mode` is `platform_managed`, the `identity_provider_ref` is required.

```yaml
# Wrong — platform_managed requires identity_provider_ref
spec:
  management_mode: platform_managed

# Correct
spec:
  management_mode: platform_managed
  identity_provider_ref:
    org: stigmer
    kind: identity_provider
    slug: planton-idp
  external_org_id: "planton-org-12345"
```

### Attempting to change management_mode after creation

`management_mode` is immutable. Changing it in an `apply` or `update` call will fail.

```bash
# This will fail if the org was created as self_managed
stigmer org apply org-now-platform-managed.yaml
# Error: management_mode is immutable after creation
```

### Attempting to change the slug after creation

An update or apply ignores a different `metadata.slug`; the slug changes only through `rename`, which owners may call. An apply that names the organization only by a new slug finds no organization under it and creates a second one, so carry the organization's `metadata.id` (as `get -o yaml` prints it) when editing a manifest: the CLI's `apply` then sends the new slug through `rename` for you.

```yaml
# Renames acme-corp to acme: the id names the organization,
# and the CLI follows the apply with a rename
metadata:
  id: org_01j9w3k7m2x4n6p8q0r2s4t6v8
  slug: acme  # was acme-corp
```

Always use `stigmer org get <slug>` to confirm the existing slug before updating.

### Using integers for `kind` in identity_provider_ref

```yaml
# Wrong
identity_provider_ref:
  kind: 50  # proto enum integer

# Correct
identity_provider_ref:
  kind: identity_provider
```

### Missing `external_org_id` for platform_managed organizations

While `external_org_id` has no proto-level validation enforcing presence, omitting it on a `platform_managed` organization makes reverse lookup impossible for the integrating platform.

```yaml
# Incomplete — platform cannot look up this org by its own identifier
spec:
  management_mode: platform_managed
  identity_provider_ref:
    org: stigmer
    kind: identity_provider
    slug: planton-idp
  # external_org_id missing

# Complete
spec:
  management_mode: platform_managed
  identity_provider_ref:
    org: stigmer
    kind: identity_provider
    slug: planton-idp
  external_org_id: "planton-org-7a3f2c91"
```

### Deleting an organization without accounting for what it holds

Deleting an organization is irreversible. Its members lose access to
everything under it: agents, workflows, MCP servers, skills, sessions and
executions. Its slug is released: a later organization may take it, and
that organization reaches nothing the deleted one owned, because every
resource names its organization by id.

On a server that holds one organization, the open-source edition, that
organization cannot be deleted at all: the delete is refused with
`ORGANIZATION_IS_SINGLE` before anything is written. The same server refuses
a second organization with `ORGANIZATION_LIMIT_REACHED`.

```bash
# Verify contents before deleting
stigmer list agents --org my-org
stigmer list workflows --org my-org

# Then delete
stigmer org delete my-org
```
