#!/usr/bin/env python3
import argparse
import datetime as dt
import hashlib
import ipaddress
import json
import os
import re
import stat
import sys
import urllib.error
import urllib.parse
import urllib.request

REVISION = re.compile(r"^[0-9a-f]{40}$")
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
PLAN_HASH = re.compile(r"^[0-9a-f]{64}$")
TOKEN = re.compile(r"^(?:gh[pousr]_[A-Za-z0-9]{20,250}|github_pat_[A-Za-z0-9_]{20,250})$")
DO_TOKEN = re.compile(r"^(?:dop_v1_|doo_v1_)[A-Za-z0-9]{20,250}$")
APP_ID = re.compile(r"^[0-9a-f-]{20,64}$")
MAXIMUM_PAGES = 10
PAGE_SIZE = 100
MAXIMUM_RESPONSE_BYTES = 2 * 1024 * 1024


class RejectRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file_pointer, code, message, headers, new_url):
        return None


NO_REDIRECT_OPENER = urllib.request.build_opener(RejectRedirects())


class PartialDeleteError(RuntimeError):
    def __init__(self, deleted):
        super().__init__("GHCR deletion stopped after a partial provider failure")
        self.deleted = deleted


def fail(message):
    raise RuntimeError(message)


def regular_file(path, mode):
    status = os.lstat(path)
    if (
        not stat.S_ISREG(status.st_mode)
        or status.st_uid != os.getuid()
        or stat.S_IMODE(status.st_mode) != mode
    ):
        fail("A protected retention input has unsafe metadata")
    return status


def load_json(path, mode=0o600, maximum_bytes=256 * 1024):
    status = regular_file(path, mode)
    if status.st_size < 2 or status.st_size > maximum_bytes:
        fail("A retention input has an invalid size")
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        with os.fdopen(descriptor, "r", encoding="utf-8", closefd=False) as handle:
            value = json.load(handle)
    finally:
        os.close(descriptor)
    if not isinstance(value, dict):
        fail("A retention input is not an object")
    return value


def read_token(path, pattern, label):
    status = regular_file(path, 0o600)
    if status.st_size < 20 or status.st_size > 300:
        fail(f"The {label} token file is invalid")
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        value = os.read(descriptor, 300).decode("ascii")
    finally:
        os.close(descriptor)
    if not pattern.fullmatch(value):
        fail(f"The {label} token is invalid")
    return value


def utc_timestamp(value, label):
    if not isinstance(value, str) or not value.endswith("Z"):
        fail(f"{label} has an invalid timestamp")
    try:
        return dt.datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as error:
        raise RuntimeError(f"{label} has an invalid timestamp") from error


def api_request(url, token, method="GET"):
    request = urllib.request.Request(
        url,
        method=method,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "User-Agent": "capstone-chat-app-platform-retention",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    try:
        return NO_REDIRECT_OPENER.open(request, timeout=20)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"Provider API request failed with status {error.code}") from error
    except urllib.error.URLError as error:
        raise RuntimeError("Provider API request failed") from error


def json_request(url, token):
    with api_request(url, token) as response:
        try:
            contents = response.read(MAXIMUM_RESPONSE_BYTES + 1)
            if len(contents) > MAXIMUM_RESPONSE_BYTES:
                fail("Provider API response exceeded its reviewed bound")
            return json.loads(contents.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise RuntimeError("Provider API returned invalid JSON") from error


def github_base(repository):
    if repository != "jmjalil96/capstone-chat":
        fail("GitHub repository changed")
    return f"https://api.github.com/repos/{repository}"


def protected_main_head(repository, token):
    value = json_request(f"{github_base(repository)}/git/ref/heads/main", token)
    revision = value.get("object", {}).get("sha") if isinstance(value, dict) else None
    if not isinstance(revision, str) or not REVISION.fullmatch(revision):
        fail("Protected main authority is invalid")
    return revision


def package_base_url(scope, owner, package):
    if scope not in ("orgs", "users"):
        fail("GitHub package API scope is invalid")
    if not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})", owner):
        fail("GitHub package owner is invalid")
    if package != "capstone-chat":
        fail("GitHub package name changed")
    return (
        f"https://api.github.com/{scope}/{urllib.parse.quote(owner, safe='')}"
        f"/packages/container/{urllib.parse.quote(package, safe='')}"
    )


def list_pages(url, token, key=None):
    values = []
    separator = "&" if "?" in url else "?"
    for page in range(1, MAXIMUM_PAGES + 1):
        result = json_request(f"{url}{separator}per_page={PAGE_SIZE}&page={page}", token)
        page_value = result.get(key) if key is not None and isinstance(result, dict) else result
        if not isinstance(page_value, list):
            fail("Provider API returned an invalid list")
        values.extend(page_value)
        if len(page_value) < PAGE_SIZE:
            return values
    fail("Provider inventory exceeded the reviewed pagination bound")


def validate_release_payload(payload, repository):
    if not isinstance(payload, dict):
        fail("Production Deployment payload is invalid")
    expected_keys = {
        "ciRunId",
        "ciWorkflowUrl",
        "digest",
        "digitalOceanAppId",
        "digitalOceanDeploymentId",
        "image",
        "operation",
        "previousDigest",
        "previousRevision",
        "revision",
        "schema",
        "type",
    }
    if set(payload) != expected_keys:
        fail("Production Deployment payload schema changed")
    digest = payload.get("digest")
    revision = payload.get("revision")
    if (
        payload.get("schema") != 2
        or payload.get("type") != "release"
        or payload.get("operation") not in ("deploy", "initial", "rollback")
        or not isinstance(digest, str)
        or not DIGEST.fullmatch(digest)
        or not isinstance(revision, str)
        or not REVISION.fullmatch(revision)
        or payload.get("image") != f"ghcr.io/{repository}@{digest}"
        or not isinstance(payload.get("ciRunId"), int)
        or payload.get("ciRunId") <= 0
        or payload.get("ciWorkflowUrl")
        != f"https://github.com/{repository}/actions/runs/{payload.get('ciRunId')}"
        or not isinstance(payload.get("digitalOceanAppId"), str)
        or not APP_ID.fullmatch(payload.get("digitalOceanAppId"))
        or not isinstance(payload.get("digitalOceanDeploymentId"), str)
        or len(payload.get("digitalOceanDeploymentId")) < 8
    ):
        fail("Production Deployment payload is inconsistent")
    previous_revision = payload.get("previousRevision")
    previous_digest = payload.get("previousDigest")
    if not (
        (previous_revision == "" and previous_digest == "")
        or (
            isinstance(previous_revision, str)
            and REVISION.fullmatch(previous_revision)
            and isinstance(previous_digest, str)
            and DIGEST.fullmatch(previous_digest)
        )
    ):
        fail("Production Deployment predecessor is invalid")
    return payload


def accepted_releases(repository, token):
    base = github_base(repository)
    deployments = list_pages(f"{base}/deployments?environment=production", token)
    releases = []
    checked_runs = {}
    for deployment in deployments:
        if not isinstance(deployment, dict):
            fail("GitHub Deployment entry is invalid")
        payload = deployment.get("payload")
        if not isinstance(payload, dict) or payload.get("type") != "release":
            continue
        payload = validate_release_payload(payload, repository)
        deployment_id = deployment.get("id")
        if not isinstance(deployment_id, int) or deployment_id <= 0:
            fail("GitHub Deployment ID is invalid")
        if (
            deployment.get("ref") != payload["revision"]
            or deployment.get("environment") != "production"
        ):
            fail("GitHub Deployment authority is inconsistent")
        ci_run_id = payload["ciRunId"]
        run = checked_runs.get(ci_run_id)
        if run is None:
            run = json_request(f"{base}/actions/runs/{ci_run_id}", token)
            checked_runs[ci_run_id] = run
        if (
            run.get("name") != "CI"
            or run.get("path") != ".github/workflows/ci.yml"
            or run.get("conclusion") != "success"
            or run.get("event") != "push"
            or run.get("head_branch") != "main"
            or run.get("head_sha") != payload["revision"]
            or run.get("html_url") != payload["ciWorkflowUrl"]
        ):
            fail("Accepted release CI evidence is inconsistent")
        created_at = deployment.get("created_at")
        releases.append(
            {
                **payload,
                "createdAt": created_at,
                "createdTimestamp": utc_timestamp(created_at, "Production Deployment"),
                "githubDeploymentId": deployment_id,
            }
        )
    releases.sort(
        key=lambda item: (item["createdTimestamp"], item["githubDeploymentId"]), reverse=True
    )
    if any(
        releases[index - 1]["createdTimestamp"] == releases[index]["createdTimestamp"]
        for index in range(1, len(releases))
    ):
        fail("Accepted release order is ambiguous")
    if not releases:
        fail("No accepted production release evidence exists")
    return releases


def parse_inventory(versions):
    known = []
    unknown_count = 0
    ids = set()
    digests = set()
    for value in versions:
        metadata = value.get("metadata") if isinstance(value, dict) else None
        container = metadata.get("container") if isinstance(metadata, dict) else None
        tags = container.get("tags") if isinstance(container, dict) else None
        version_id = value.get("id") if isinstance(value, dict) else None
        digest = value.get("name") if isinstance(value, dict) else None
        if (
            not isinstance(version_id, int)
            or version_id <= 0
            or not isinstance(digest, str)
            or not DIGEST.fullmatch(digest)
            or not isinstance(tags, list)
            or any(not isinstance(tag, str) for tag in tags)
            or version_id in ids
            or digest in digests
        ):
            unknown_count += 1
            continue
        ids.add(version_id)
        digests.add(digest)
        known.append({"digest": digest, "id": version_id, "tags": sorted(set(tags))})
    return known, unknown_count


def component_digest(spec, image_repository):
    if not isinstance(spec, dict):
        fail("DigitalOcean deployment spec is missing")
    components = [*(spec.get("services") or []), *(spec.get("jobs") or [])]
    if len(components) != 2:
        fail("DigitalOcean steady spec topology changed")
    repository_authority = image_repository.removeprefix("ghcr.io/").split("/", 1)
    if len(repository_authority) != 2:
        fail("DigitalOcean image repository authority is invalid")
    registry, repository = repository_authority
    digests = set()
    for component in components:
        image = component.get("image") if isinstance(component, dict) else None
        digest = image.get("digest") if isinstance(image, dict) else None
        if (
            not isinstance(digest, str)
            or not DIGEST.fullmatch(digest)
            or image.get("registry_type") != "GHCR"
            or image.get("registry") != registry
            or image.get("repository") != repository
            or "tag" in image
            or "deploy_on_push" in image
        ):
            fail("DigitalOcean deployment image authority changed")
        digests.add(digest)
    if len(digests) != 1:
        fail("DigitalOcean service and migration digests differ")
    return next(iter(digests))


def deployment_spec(app_id, deployment, do_token):
    if not isinstance(deployment, dict) or not isinstance(deployment.get("id"), str):
        fail("DigitalOcean deployment authority is invalid")
    if isinstance(deployment.get("spec"), dict):
        return deployment["spec"]
    value = json_request(
        f"https://api.digitalocean.com/v2/apps/{urllib.parse.quote(app_id)}/deployments/"
        f"{urllib.parse.quote(deployment['id'])}",
        do_token,
    )
    resolved = value.get("deployment") if isinstance(value, dict) else None
    if not isinstance(resolved, dict) or resolved.get("id") != deployment["id"]:
        fail("DigitalOcean returned the wrong deployment")
    return resolved.get("spec")


def app_authority(app_id, do_token, image_repository):
    value = json_request(
        f"https://api.digitalocean.com/v2/apps/{urllib.parse.quote(app_id)}", do_token
    )
    app = value.get("app") if isinstance(value, dict) else None
    if not isinstance(app, dict) or app.get("id") != app_id:
        fail("DigitalOcean returned the wrong App")
    spec = app.get("spec")
    if not isinstance(spec, dict) or spec.get("egress") != {"type": "DEDICATED_IP"}:
        fail("DigitalOcean App lost Dedicated Egress authority")
    dedicated = app.get("dedicated_ips")
    if (
        not isinstance(dedicated, list)
        or len(dedicated) != 2
        or any(value.get("status") != "ASSIGNED" for value in dedicated)
    ):
        fail("DigitalOcean App dedicated egress pair is not assigned")
    try:
        dedicated_ips = sorted(str(ipaddress.IPv4Address(value.get("ip"))) for value in dedicated)
    except ipaddress.AddressValueError as error:
        raise RuntimeError("DigitalOcean App dedicated egress pair is invalid") from error
    if len(set(dedicated_ips)) != 2:
        fail("DigitalOcean App dedicated egress pair is invalid")
    desired_digest = component_digest(spec, image_repository)
    active = app.get("active_deployment")
    active_digest = component_digest(deployment_spec(app_id, active, do_token), image_repository)
    in_progress = app.get("in_progress_deployment")
    in_progress_digest = None
    if in_progress is not None:
        in_progress_digest = component_digest(
            deployment_spec(app_id, in_progress, do_token), image_repository
        )
    return {
        "activeDeploymentId": active.get("id"),
        "activeDigest": active_digest,
        "appId": app_id,
        "dedicatedIps": dedicated_ips,
        "desiredDigest": desired_digest,
        "inProgressDeploymentId": None if in_progress is None else in_progress.get("id"),
        "inProgressDigest": in_progress_digest,
        "updatedAt": app.get("updated_at"),
    }


def recovery_pins(path, releases):
    document = load_json(path)
    if set(document) != {"pins", "schema"} or document.get("schema") != 1:
        fail("Recovery pin authority schema changed")
    pins = document.get("pins")
    if not isinstance(pins, list):
        fail("Recovery pin authority is invalid")
    accepted = {(item["revision"], item["digest"]) for item in releases}
    result = []
    observed = set()
    for pin in pins:
        if not isinstance(pin, dict) or set(pin) != {"digest", "revision"}:
            fail("Recovery pin is invalid")
        pair = (pin.get("revision"), pin.get("digest"))
        if (
            not isinstance(pair[0], str)
            or not REVISION.fullmatch(pair[0])
            or not isinstance(pair[1], str)
            or not DIGEST.fullmatch(pair[1])
            or pair not in accepted
            or pair in observed
        ):
            fail("Recovery pin conflicts with accepted release evidence")
        observed.add(pair)
        result.append({"digest": pair[1], "revision": pair[0]})
    return sorted(result, key=lambda item: (item["revision"], item["digest"]))


def plan_core(
    versions,
    app,
    releases,
    pins,
    repository,
):
    known, malformed_count = parse_inventory(versions)
    protected = {}

    def protect(digest, reason):
        protected.setdefault(digest, set()).add(reason)

    protect(app["activeDigest"], "active-serving")
    protect(app["desiredDigest"], "desired-spec")
    if app["inProgressDigest"] is not None:
        protect(app["inProgressDigest"], "in-progress")
    active_release = releases[0]
    if active_release["digitalOceanAppId"] != app["appId"]:
        fail("Accepted release targets a different DigitalOcean App")
    if active_release["digest"] not in (app["activeDigest"], app["desiredDigest"]):
        fail("Accepted release and DigitalOcean authority disagree")
    previous_pair = (active_release["previousRevision"], active_release["previousDigest"])
    if previous_pair != ("", ""):
        if previous_pair not in {(item["revision"], item["digest"]) for item in releases}:
            fail("Immediately previous compatible release is unavailable")
        protect(previous_pair[1], "previous")
    recent = []
    for release in releases:
        if release["digest"] in recent:
            continue
        recent.append(release["digest"])
        protect(release["digest"], "recent-five")
        if len(recent) == 5:
            break
    for pin in pins:
        protect(pin["digest"], "recovery-pin")

    accepted_digests = {item["digest"] for item in releases}
    releases_by_digest = {}
    for release in releases:
        releases_by_digest.setdefault(release["digest"], []).append(release)
    versions_by_digest = {item["digest"]: item for item in known}
    required_revision_pairs = {
        (active_release["digest"], active_release["revision"]),
        *(
            {(previous_pair[1], previous_pair[0])}
            if previous_pair != ("", "")
            else set()
        ),
        *((pin["digest"], pin["revision"]) for pin in pins),
    }
    for recent_digest in recent:
        recent_release = releases_by_digest[recent_digest][0]
        required_revision_pairs.add((recent_digest, recent_release["revision"]))
    for protected_digest, protected_revision in required_revision_pairs:
        version = versions_by_digest.get(protected_digest)
        if version is None or protected_revision not in version["tags"]:
            fail("Protected release lacks its exact GHCR full-revision tag")

    candidates = [
        item
        for item in known
        if item["digest"] in accepted_digests
        and item["digest"] not in protected
        and any(
            release["revision"] in item["tags"]
            for release in releases_by_digest[item["digest"]]
        )
    ]
    candidate_digests = {item["digest"] for item in candidates}
    unknown = (
        sum(
            1
            for item in known
            if item["digest"] not in accepted_digests
            or (item["digest"] not in protected and item["digest"] not in candidate_digests)
        )
        + malformed_count
    )
    normalized_releases = [
        {
            key: value
            for key, value in item.items()
            if key not in ("createdTimestamp",)
        }
        for item in releases
    ]
    return {
        "acceptedReleaseCount": len(releases),
        "appAuthority": app,
        "candidateVersions": sorted(candidates, key=lambda item: (item["digest"], item["id"])),
        "inventoryCount": len(versions),
        "protectedDigests": [
            {"digest": digest, "reasons": sorted(reasons)}
            for digest, reasons in sorted(protected.items())
        ],
        "recoveryPins": pins,
        "releases": normalized_releases,
        "repository": repository,
        "unknownVersionsLeftUntouched": unknown,
    }


def canonical_bytes(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def fsync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def write_plan(path, core):
    document = {
        "core": core,
        "generatedAt": dt.datetime.now(dt.timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z"),
        "schema": 2,
    }
    contents = canonical_bytes(document)
    if len(contents) > 512 * 1024:
        fail("Retention plan exceeded its reviewed size bound")
    descriptor = os.open(
        path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600
    )
    try:
        os.fchmod(descriptor, 0o600)
        offset = 0
        while offset < len(contents):
            offset += os.write(descriptor, contents[offset:])
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    fsync_directory(os.path.dirname(os.path.realpath(path)))
    return hashlib.sha256(contents).hexdigest()


def delete_plan(
    path,
    expected_hash,
    current_core,
    base_url,
    token,
    repository,
    github_token,
    tool_revision,
):
    if not PLAN_HASH.fullmatch(expected_hash):
        fail("Confirmed retention plan hash is invalid")
    document = load_json(path, maximum_bytes=512 * 1024)
    if set(document) != {"core", "generatedAt", "schema"} or document.get("schema") != 2:
        fail("Retention plan schema changed")
    contents = canonical_bytes(document)
    if hashlib.sha256(contents).hexdigest() != expected_hash:
        fail("Confirmed retention plan hash does not match")
    generated_at = utc_timestamp(document.get("generatedAt"), "Retention plan")
    now = dt.datetime.now(dt.timezone.utc)
    if generated_at > now or now - generated_at > dt.timedelta(hours=1):
        fail("Retention plan is stale")
    if document.get("core") != current_core:
        fail("Provider or recovery protection state changed after the dry run")
    deleted = 0
    try:
        for candidate in current_core["candidateVersions"]:
            if protected_main_head(repository, github_token) != tool_revision:
                fail("Running retention tooling is not protected main HEAD")
            with api_request(
                f"{base_url}/versions/{candidate['id']}", token, method="DELETE"
            ) as response:
                if response.status != 204:
                    fail("GitHub package deletion did not return 204")
            deleted += 1
    except Exception as error:
        raise PartialDeleteError(deleted) from error
    os.unlink(path)
    fsync_directory(os.path.dirname(os.path.realpath(path)))
    return deleted


def build_current_core(arguments, github_token, package_token, do_token, base_url):
    versions = list_pages(f"{base_url}/versions", package_token)
    repository = f"{arguments.owner}/{arguments.package}"
    releases = accepted_releases(repository, github_token)
    pins = recovery_pins(arguments.recovery_pins_file, releases)
    app = app_authority(arguments.app_id, do_token, arguments.image_repository)
    return plan_core(versions, app, releases, pins, repository)


def main():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("operation", choices=("delete", "plan"))
    parser.add_argument("--app-id", required=True)
    parser.add_argument("--digitalocean-token-file", required=True)
    parser.add_argument("--github-token-file", required=True)
    parser.add_argument("--image-repository", required=True)
    parser.add_argument("--owner", required=True)
    parser.add_argument("--package", required=True)
    parser.add_argument("--package-token-file", required=True)
    parser.add_argument("--plan-file", required=True)
    parser.add_argument("--plan-hash", default="")
    parser.add_argument("--recovery-pins-file", required=True)
    parser.add_argument("--scope", required=True)
    parser.add_argument("--tool-revision", required=True)
    arguments = parser.parse_args()

    repository = f"{arguments.owner}/{arguments.package}"
    if repository != "jmjalil96/capstone-chat":
        fail("GitHub repository changed")
    if arguments.image_repository != f"ghcr.io/{repository}":
        fail("GHCR API target and deployment image repository disagree")
    if not APP_ID.fullmatch(arguments.app_id):
        fail("DigitalOcean App ID is invalid")
    if not REVISION.fullmatch(arguments.tool_revision):
        fail("Retention tooling revision is invalid")
    github_token = read_token(arguments.github_token_file, TOKEN, "GitHub API")
    package_token = read_token(arguments.package_token_file, TOKEN, "GitHub package")
    do_token = read_token(arguments.digitalocean_token_file, DO_TOKEN, "DigitalOcean")
    base_url = package_base_url(arguments.scope, arguments.owner, arguments.package)
    core = build_current_core(
        arguments, github_token, package_token, do_token, base_url
    )

    if arguments.operation == "plan":
        if arguments.plan_hash:
            fail("Dry-run retention does not accept a plan hash")
        plan_hash = write_plan(arguments.plan_file, core)
        output = {
            "candidateVersions": len(core["candidateVersions"]),
            "operation": "plan",
            "planSha256": plan_hash,
            "protectedDigests": len(core["protectedDigests"]),
            "repository": repository,
            "unknownVersionsLeftUntouched": core["unknownVersionsLeftUntouched"],
        }
    else:
        deleted = delete_plan(
            arguments.plan_file,
            arguments.plan_hash,
            core,
            base_url,
            package_token,
            repository,
            github_token,
            arguments.tool_revision,
        )
        output = {
            "deletedVersions": deleted,
            "operation": "delete",
            "planSha256": arguments.plan_hash,
            "repository": repository,
        }
    sys.stdout.write(json.dumps(output, sort_keys=True, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    try:
        main()
    except PartialDeleteError as error:
        sys.stderr.write(
            json.dumps(
                {
                    "deletedVersionsBeforeFailure": error.deleted,
                    "errorName": type(error).__name__,
                    "outcome": "failed",
                },
                sort_keys=True,
                separators=(",", ":"),
            )
            + "\n"
        )
        raise SystemExit(1)
    except Exception as error:
        sys.stderr.write(
            json.dumps(
                {"errorName": type(error).__name__, "outcome": "failed"},
                sort_keys=True,
                separators=(",", ":"),
            )
            + "\n"
        )
        raise SystemExit(1)
