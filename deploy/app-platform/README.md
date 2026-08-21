# DigitalOcean App Platform contracts

This directory is the read-only provider contract for both hosted environments. App Platform
builds `apps/api/Dockerfile` from the repository root. Autodeploy is disabled and each environment
has one protected source pointer:

- staging: `app-platform-staging`;
- production: `app-platform-production`.

`contract.mjs` is the sole desired-contract authority. Its common contract defines the normal
server, one migration-only `PRE_DEPLOY` job, source, health, termination, alerts, edge policy, and
component secret scopes; fixed staging and production overlays supply branch, domain, size,
environment, sender, and Dedicated Egress policy. It contains secret names only.

Both source builds receive `DEPLOYMENT_REVISION=${_self.COMMIT_HASH}` at runtime. The validator
requires the desired and active specs, service and job source hashes, encrypted variables, domain,
ingress, edge settings, production egress, and absence of extra or in-progress components to match
exactly. Independent builds of one source commit are not claimed to be byte-identical artifacts.

The normal release workflow only fast-forwards an existing protected pointer, requests one source
deployment, validates it, and checks the public readiness revision. Initial pointer creation and
App configuration are separately authorized provisioning. The minimal `health-bootstrap`
entrypoint is available only for first provisioning or controlled recovery; it is not a release
stage or a product configuration.

## Validate captured state

Capture provider state in an owner-only temporary file; it contains encrypted secret values and
must not be printed or uploaded.

```sh
umask 077
work_directory="$(mktemp -d)"
trap 'rm -rf -- "$work_directory"' EXIT
doctl apps get "$DIGITALOCEAN_APP_ID" --output json > "$work_directory/app.json"
chmod 600 "$work_directory/app.json"

node deploy/app-platform/live-contract.mjs validate \
  --environment staging \
  --live-file "$work_directory/app.json" \
  --app-id "$DIGITALOCEAN_APP_ID" \
  --revision "$EXPECTED_RELEASE_REVISION"
```

Use `--environment production` for production. Successful output contains only safe identifiers,
the environment, revision, and sorted production egress addresses. Inputs must be regular,
owner-only `0600` files.

Run the network-free fixtures with:

```sh
node deploy/app-platform/contract.test.mjs
```
