# DigitalOcean App Platform contract

This directory records and validates the provider-specific deployment boundary for Capstone Chat.
It is intentionally read-only: repository checks can inspect a captured DigitalOcean App response,
but nothing here creates, updates, deploys, or deletes an external resource.

## Native GitHub source

App Platform builds `apps/api/Dockerfile` directly from the repository root. Both the service and
the pre-deploy migration job use the same GitHub source, Dockerfile, and release pointer, with
native autodeploy disabled:

- production: `jmjalil96/capstone-chat`, branch `app-platform-production`;
- rehearsal: `jmjalil96/capstone-chat`, branch `app-platform-rehearsal`;
- source directory: `/`;
- Dockerfile: `apps/api/Dockerfile`;
- `deploy_on_push: false`.

The protected release pointer is advanced only after the exact revision passes CI. An operator
then starts the App Platform deployment explicitly. This preserves a reviewable release gate
without maintaining a second GHCR publication, registry credential, image-retention system, or a
custom DigitalOcean mutation client.

Each component receives `DEPLOYMENT_REVISION=${_self.COMMIT_HASH}` at run time. The validator also
requires the service and migration job in the active deployment to report that same expected full
40-character source commit. App Platform bindable variables are not used as Docker build arguments.
The Dockerfile pins its frontend and multi-platform Node/Alpine base by digest; dependency versions
and the pnpm lockfile remain committed.

## Contracts

There are four contracts:

- `bootstrap.contract.yaml`: production health-only service, before secrets, Dedicated Egress,
  the custom domain, or a migration job exist;
- `app.contract.yaml`: final production service, Dedicated Egress, domain and edge policy,
  migration job, alerts, and component-scoped environment declarations;
- `rehearsal-bootstrap.contract.yaml`: disposable rehearsal equivalent of bootstrap;
- `rehearsal.contract.yaml`: final isolated load-rehearsal service and migration job.

Bootstrap contracts deliberately omit custom-domain edge fields. DigitalOcean may return explicit
`false` defaults before a custom domain exists; validation accepts those harmless defaults and
rejects enabled edge behavior. Final contracts require the reviewed domain and all three edge
values exactly. The validator also normalizes only DigitalOcean's probed safe omissions for
false/default fields; unknown keys and non-default values still fail closed.
DigitalOcean may expose its generated `DEFAULT` hostname only through `default_ingress`; final
validation therefore requires the exact PRIMARY and accepts at most one matching provider DEFAULT.
DigitalOcean desired and active ingress specs must retain its literal `${STARTER_DOMAIN}` binding
for the redirect authority. The validator independently verifies `default_ingress`, while the
public launch check proves that the resolved starter hostname redirects without becoming another
authenticated origin.

Contracts declare secret names, never values. Final live validation requires every declared
secret to be returned as a provider-encrypted `EV[...]` value, forbids App-level environment
variables and extra components, and verifies environment scope, source identity, health checks,
termination policy, alerts, ingress, domain, edge settings, and Dedicated Egress.

DigitalOcean canonically returns the top-level feature `buildpack-stack=ubuntu-22`, including for
Dockerfile builds. All four contracts require that exact singleton value in both desired and
active deployment specs; missing, additional, or changed features fail closed.

Validation covers both the outer desired App spec and `active_deployment.spec`. A dashboard change
that has not become the active deployment, or an active deployment with an extra component, cannot
pass merely because the desired spec is correct. During first provisioning, the operator makes one
separately authorized dashboard transition from the bootstrap contract to the exact final contract,
validates that provisional active deployment, and only then runs the protected production release
workflow. The workflow never acts as an App-configuration mutator.

## Validate captured provider state

Capture the App response into a fresh owner-only file. Do not print or upload it because it contains
provider-encrypted secret fields.

```sh
umask 077
work_directory="$(mktemp -d)"
trap 'rm -rf -- "$work_directory"' EXIT
doctl apps get "$DIGITALOCEAN_APP_ID" --output json > "$work_directory/app.json"
chmod 600 "$work_directory/app.json"

node deploy/app-platform/live-contract.mjs validate \
  --mode live \
  --live-file "$work_directory/app.json" \
  --app-id "$DIGITALOCEAN_APP_ID" \
  --revision "$EXPECTED_RELEASE_REVISION"
```

Use `bootstrap`, `rehearsal-bootstrap`, or `rehearsal` for the other three contracts. Successful
output contains only the App ID, deployment ID, mode, expected revision, and sorted Dedicated
Egress addresses. The tool rejects non-regular inputs, symlinks, other owners, and modes other than
`0600`.

## Local verification

This test makes no network requests:

```sh
node deploy/app-platform/contract.test.mjs
```
