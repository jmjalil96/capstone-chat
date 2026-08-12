# DigitalOcean App Platform deployment adapter

This directory is the repository-side, provider-specific adapter for the approved Capstone Chat
App Platform candidate. It does not provision or mutate any external resource during ordinary
repository checks. The application and database remain portable OCI and PostgreSQL boundaries;
the files here deliberately encode the one approved DigitalOcean control-plane contract.

## Contracts

- `app.contract.yaml` is the accepted steady structure: one 1 GiB service, one 512 MiB
  `PRE_DEPLOY` migration job, Dedicated Egress, the production domain, managed ingress, health
  checks, termination budgets, alerts, and component-scoped environment declarations.
- `bootstrap.contract.yaml` is the temporary, runtime-secret-free health-only service used before
  Dedicated Egress exists.
- `egress.contract.yaml` is the same health-only service with Dedicated Egress requested and no
  custom domain or pre-deploy job.
- `domain.contract.yaml` is the health-only service after the assigned egress pair is allowlisted,
  with the production domain and provider-default redirect attached but no pre-deploy job.
- `initialization.contract.yaml` is the temporary bootstrap service plus the single ordered
  initialization job. It is never a valid final production contract.

All five files are intentionally digest-free and contain neither secret values nor
`DEPLOYMENT_REVISION`. A release supplies one full revision and one immutable `sha256:` digest. The
image owns the revision; the App spec cannot override it.

For App Platform's `GHCR` image schema, `registry` is the GitHub owner (`jmjalil96`) and
`repository` is the package name (`capstone-chat`). `ghcr.io/jmjalil96/capstone-chat` remains the
OCI/GitHub API authority, but `ghcr.io` is not written into the App spec's `registry` field.
This follows DigitalOcean's official [App Spec reference](https://docs.digitalocean.com/products/app-platform/reference/app-spec/)
and [container-image deployment guide](https://docs.digitalocean.com/products/app-platform/how-to/deploy-from-container-images/).

`live-contract.mjs` parses these contracts strictly, renders a protected API request body, and
validates fetched live state. Every JSON file containing a fetched App spec, provider-encrypted
value, plaintext first-field input, or rendered request must be a current-user-owned regular file
with mode `0600` in a fresh temporary directory. The renderer creates its output exclusively and
never prints the spec.

## First private-GHCR fields

DigitalOcean can return an encrypted `EV[...]` value only after receiving a newly introduced
image field once. For that one submission, provide a protected JSON document of this shape:

```json
{"components":{"capstone-chat":{"registry_credentials":"username:read-only-token"}},"schema":1}
```

Use `--registry-mode introduce` only for a component whose fetched live image block has no
credential yet. Existing components must already contain an `EV[...]` value, which is preserved
byte-for-byte. `--registry-mode rotate` requires a new plaintext value for every image-bearing
component in one reviewed update. Plaintext is accepted only from the protected input file, never
an argument or environment variable. Delete the input and rendered body on every exit, fetch the
App immediately after submission, and run mode-appropriate validation before proceeding.

Runtime-secret introduction uses the same protected document boundary through
`--secret-input-file` and `--secret-mode introduce`. Ordinary deploys and rollbacks accept no
plaintext input and preserve every provider-encrypted runtime and registry field.

The selected non-secret New Relic region is a separate protected renderer input using
`--general-input-file` and `--general-mode introduce`; the only accepted values are the exact US or
EU OTLP origins. It is stored as a component-scoped `GENERAL` value, never as a sixth secret.

Example rendering syntax (values are illustrative names, not authorization to provision):

```sh
umask 077
work_directory="$(mktemp -d)"
trap 'rm -rf -- "$work_directory"' EXIT
node deploy/app-platform/live-contract.mjs render \
  --mode bootstrap \
  --revision "$CAPSTONE_IMAGE_REVISION" \
  --digest "$CAPSTONE_IMAGE_DIGEST" \
  --registry-mode introduce \
  --registry-input-file "$work_directory/registry.json" \
  --output "$work_directory/create-body.json"
```

The output is an API request body (`{"spec": ...}`), not a directly applicable `doctl --spec`
file. The guided procedure submits these same contracts through `provision.mjs create-bootstrap`
and `provision.mjs advance <source> <target>` with a short-lived provisioning token. Each mutation
requires a protected-main tooling/image revision, successful exact CI, and—for updates—the freshly
reviewed active deployment ID in `CAPSTONE_PROVISIONING_BASE_DEPLOYMENT_ID`.
The short-lived GitHub token must also read the private GHCR package. Before any create/update,
the provisioner requires the full-revision tag to resolve uniquely to
`CAPSTONE_IMAGE_DIGEST`; successful protected-main CI is the artifact's OCI/runtime/web identity
attestation. CI never remaps an existing full-revision tag: an exact rebuilt image is reused, while
different content fails closed.

```sh
export CAPSTONE_TOOL_REVISION="$CAPSTONE_IMAGE_REVISION"
CAPSTONE_REGISTRY_INPUT_FILE="$work_directory/registry.json" \
  node deploy/app-platform/provision.mjs create-bootstrap

export DIGITALOCEAN_APP_ID="<fetched-app-id>"
export CAPSTONE_PROVISIONING_BASE_DEPLOYMENT_ID="<fetched-active-deployment-id>"
node deploy/app-platform/provision.mjs advance bootstrap egress
```

The egress result emits only the assigned address pair. Preserve its exact sorted comma-separated
value in `CAPSTONE_EXPECTED_EGRESS_IPV4S`; every egress-to-later transition requires it and refuses
a different current pair. Refresh the base deployment ID after each accepted stage. If a provider
response fails after target activation, repeating with the original base reconciles only when that
target is its immediate provider successor; it never blindly submits a second PUT.
Protected plaintext registry/runtime/input files are consumable inputs: `provision.mjs` and
`configure.mjs` remove every file they open in a `finally` boundary, including parse and provider
failures. Keep the surrounding mode-`0700` temporary directory trap for fetched encrypted specs
and other non-consumed evidence.
After DigitalOcean creates the App, fetch the response into another mode-`0600` file and validate
it with `live-contract.mjs validate --mode bootstrap`. Every later render requires that fetched
file through `--live-file` and its validated current contract through `--source-mode`; direct
bootstrap-to-domain or bootstrap-to-initialization renders fail closed. Provisioning then advances
only through
these independently rendered and validated states:

1. `bootstrap`: confirm the health-only service before requesting Dedicated Egress.
2. `egress`: wait for exactly two distinct `ASSIGNED` IPv4 addresses, validate them, and allowlist
   both at the database before continuing.
3. `domain`: attach and validate the production domain while the service remains health-only.
4. `initialization`: introduce only the initialization job's registry credential and scoped
   secrets, verify its single successful run, and remove its one-use inputs.
5. `live`: introduce the steady service and migration-job secrets, then validate the final exact
   contract.

The disposable managed rehearsal uses the parallel `rehearsal-*` contracts and exact temporary
hostname `rehearsal.chat.capstone.com.ec`. Its transient initializer contract is replaced by final
`rehearsal.contract.yaml`, which retains only the load service and migration job. Neither contract
contains an OpenRouter or Resend credential.

Every transition renders from the freshly fetched previous App and preserves its provider-encrypted
fields. Skipping or combining a stage is outside this adapter's contract. An initialized-database
cold recreation may explicitly transition `domain` to `live` only after the separate recovery
integrity/latch gate; a steady credential rotation may transition `live` to `live`. Initialization
and steady introduction use their corresponding contract and explicitly supplied current live
file.

## Steady release and rollback

`.github/workflows/deploy-production.yml` is the only steady release writer. The protected
`production` environment must contain:

- variable `DIGITALOCEAN_APP_ID`, pinned to the one production App ID;
- secret `DIGITALOCEAN_DEPLOY_TOKEN`, limited to `app:update`, `app:read`, `regions:read`,
  `sizes:read`, and `actions:read` and installed only after unsafe history eviction.

The workflow resolves the submitted full revision's private GHCR tag to a digest, pulls and
re-inspects the artifact, and then calls `deploy.mjs` or `rollback.mjs`. A normal deploy must be the
current protected `main` HEAD, a strict descendant of the accepted active revision, and backed by
a successful `CI` push run. A rollback accepts only the predecessor recorded by the current
accepted release. Both patch the current spec forward, preserving domains, egress, credentials,
and every other field. Neither invokes DigitalOcean native rollback.

Every spec writer and GHCR retention use concurrency group
`capstone-chat-production-app-spec` with cancellation disabled. The mutation helper fingerprints
the complete App spec, pinned App ID, active/in-progress deployment, egress pair, and update time;
it re-fetches immediately before the PUT and verifies the resulting deployment. DigitalOcean does
not expose an atomic compare-and-swap update, so unexpected control-panel changes are incidents,
not state the workflow overwrites.

Public readiness is a bounded convergence poll because the managed edge can briefly expose the
previous instance after DigitalOcean marks a deployment active. If DigitalOcean has already made
an exact candidate live but readiness or GitHub Deployment evidence failed afterward, rerun the
workflow with operation `reconcile` and the same requested revision. Reconciliation never mutates
the App: it requires the exact requested digest/revision, protected-main or accepted-predecessor
authority, successful CI, a safe provider history, prior-versus-live digest-only equivalence,
converged public readiness, unchanged main/App fingerprints, and no competing accepted release
before creating the missing release record. A retry after an ambiguous GitHub response returns the
already-recorded exact release instead of duplicating authority.

Initial provisioning and cold recreation run `deploy.mjs history-eviction` with the short-lived
provisioning credential outside GitHub. It repeatedly redeploys the unchanged final spec and exact
digest until ten successful rollbackable entries contain neither a pre-egress nor initialization
spec. The same bounded operator then runs `deploy.mjs adopt-initial`, which requires the exact
protected `main` revision, successful CI, ready live contract, safe ten-entry history, and no prior
accepted release before it creates the first successful GitHub production Deployment record. That
record is the ancestry baseline; it does not mutate the App. Only then may the steady token and App
ID be installed in GitHub.

The disposable capacity rehearsal performs the same bounded replay with
`deploy.mjs history-eviction-rehearsal`. That command accepts only the exact final rehearsal
contract, classifies only its load-server-plus-migration topology as rollbackable, and polls the
rehearsal hostname. Production and rehearsal histories cannot satisfy one another's gate.

## GHCR retention

`.github/workflows/ghcr-retention.yml` is deliberately two-step:

1. `plan` re-fetches the complete bounded GHCR inventory, DigitalOcean desired/active/in-progress
   authorities, successful production Deployment records with exact CI evidence, and the bounded
   recovery-pin document. It uploads a seven-day plan artifact and prints only its hash and counts.
2. After human review, `delete` downloads that exact artifact from the supplied workflow run and
   re-fetches every authority. It deletes only if the recomputed plan is byte-for-byte identical
   and the reviewed SHA-256 matches.

The `production` environment additionally holds `GHCR_RETENTION_TOKEN`, a package-delete
credential distinct from the App's read-only pull credential. Unknown, malformed, unaccepted, or
beyond-pagination versions remain untouched. Active-serving, desired, in-progress, previous,
recent-five, and recovery-pinned digests are never candidates. A partial provider failure retains
the plan and reports only the count deleted before failure.

## Local verification

These tests make no network requests:

```sh
node deploy/app-platform/contract.test.mjs
node deploy/app-platform/mutate-app.test.mjs
node deploy/app-platform/github-api.test.mjs
node deploy/app-platform/release.test.mjs
node deploy/app-platform/workflow.test.mjs
python3 deploy/app-platform/ghcr-retention.test.py
```
