#!/usr/bin/env python3
import argparse
import datetime as dt
import hashlib
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
TOKEN = re.compile(r"^ghp_[A-Za-z0-9]{30,250}$")
MAXIMUM_PAGES = 10
PAGE_SIZE = 100


def fail(message):
    raise RuntimeError(message)


def regular_file(path, mode):
    status = os.lstat(path)
    if not stat.S_ISREG(status.st_mode) or status.st_uid != 0 or stat.S_IMODE(status.st_mode) != mode:
        fail("A root-owned retention input has unsafe metadata")
    return status


def load_json(path, mode, maximum_bytes=64 * 1024):
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


def read_token(path):
    status = regular_file(path, 0o600)
    if status.st_size < 20 or status.st_size > 256:
        fail("The GitHub package token file is invalid")
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        token = os.read(descriptor, 256).decode("ascii")
    finally:
        os.close(descriptor)
    if not TOKEN.fullmatch(token):
        fail("The GitHub package token is not a classic PAT")
    return token


def utc_timestamp(value):
    if not isinstance(value, str) or not value.endswith("Z"):
        fail("Accepted CI evidence has an invalid timestamp")
    try:
        return dt.datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as error:
        raise RuntimeError("Accepted CI evidence has an invalid timestamp") from error


def api_request(url, token, method="GET"):
    request = urllib.request.Request(
        url,
        method=method,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "User-Agent": "capstone-chat-ghcr-retention",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    try:
        return urllib.request.urlopen(request, timeout=15)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"GitHub package API request failed with status {error.code}") from error
    except urllib.error.URLError as error:
        raise RuntimeError("GitHub package API request failed") from error


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


def list_versions(base_url, token):
    versions = []
    for page in range(1, MAXIMUM_PAGES + 1):
        url = f"{base_url}/versions?per_page={PAGE_SIZE}&page={page}"
        with api_request(url, token) as response:
            page_value = json.load(response)
        if not isinstance(page_value, list):
            fail("GitHub package API returned an invalid version list")
        versions.extend(page_value)
        if len(page_value) < PAGE_SIZE:
            return versions
    fail("GitHub package version inventory exceeded the reviewed bound")


def accepted_evidence(evidence_root, image_repository):
    accepted = []
    by_revision = {}
    for name in sorted(os.listdir(evidence_root)):
        if not name.endswith(".json"):
            fail("CI evidence directory contains an unexpected entry")
        revision = name[:-5]
        if not REVISION.fullmatch(revision):
            fail("CI evidence filename is invalid")
        evidence = load_json(os.path.join(evidence_root, name), 0o440)
        expected_keys = {
            "conclusion",
            "digest",
            "image",
            "previousCompatible",
            "revision",
            "schema",
            "verifiedAt",
            "workflowUrl",
        }
        if set(evidence) != expected_keys:
            fail("Accepted CI evidence schema changed")
        digest = evidence.get("digest")
        if (
            evidence.get("schema") != 1
            or evidence.get("conclusion") != "success"
            or evidence.get("previousCompatible") is not True
            or evidence.get("revision") != revision
            or not isinstance(digest, str)
            or not DIGEST.fullmatch(digest)
            or evidence.get("image") != f"{image_repository}@{digest}"
        ):
            fail("Accepted CI evidence is inconsistent")
        item = {
            "digest": digest,
            "revision": revision,
            "verifiedAt": evidence["verifiedAt"],
            "verifiedTimestamp": utc_timestamp(evidence["verifiedAt"]),
        }
        accepted.append(item)
        by_revision[revision] = item
    return accepted, by_revision


def release_digest(release_path, release_root, image_repository):
    resolved = os.path.realpath(release_path)
    if not resolved.startswith(release_root + os.sep) or not REVISION.fullmatch(os.path.basename(resolved)):
        fail("Release authority escaped the immutable release root")
    metadata = load_json(os.path.join(resolved, "release.json"), 0o440)
    digest = metadata.get("digest")
    revision = metadata.get("revision")
    if (
        revision != os.path.basename(resolved)
        or not isinstance(digest, str)
        or not DIGEST.fullmatch(digest)
        or metadata.get("image") != f"{image_repository}@{digest}"
    ):
        fail("Release authority metadata is inconsistent")
    return resolved, revision, digest, metadata


def protected_digests(state_root, accepted, by_revision, image_repository, remote_digests):
    release_root = os.path.join(state_root, "releases")
    active_path = os.path.join(state_root, "active")
    if not stat.S_ISLNK(os.lstat(active_path).st_mode):
        fail("Active release authority is not a symlink")
    active, active_revision, active_digest, metadata = release_digest(
        active_path, release_root, image_repository
    )
    protected = {active_digest: {"active"}}
    previous = metadata.get("previousRelease")
    if not isinstance(previous, str):
        fail("Active release predecessor is invalid")
    if previous:
        _, _, previous_digest, _ = release_digest(previous, release_root, image_repository)
        protected.setdefault(previous_digest, set()).add("previous")

    remote_accepted = [item for item in accepted if item["digest"] in remote_digests]
    remote_accepted.sort(key=lambda item: (item["verifiedTimestamp"], item["revision"]), reverse=True)
    recent_digests = []
    for item in remote_accepted:
        if item["digest"] in recent_digests:
            continue
        recent_digests.append(item["digest"])
        protected.setdefault(item["digest"], set()).add("recent-five")
        if len(recent_digests) == 5:
            break

    pin_root = os.path.join(state_root, "recovery-pins")
    for revision in sorted(os.listdir(pin_root)):
        if not REVISION.fullmatch(revision):
            fail("Recovery pin filename is invalid")
        regular_file(os.path.join(pin_root, revision), 0o440)
        item = by_revision.get(revision)
        if item is None:
            fail("Recovery pin has no accepted CI evidence")
        protected.setdefault(item["digest"], set()).add("recovery-pin")

    if active_revision not in by_revision or by_revision[active_revision]["digest"] != active_digest:
        fail("Active release has no matching accepted CI evidence")
    return protected, active


def plan_core(versions, state_root, evidence_root, image_repository, repository):
    accepted, by_revision = accepted_evidence(evidence_root, image_repository)
    remote = []
    for version in versions:
        if not isinstance(version, dict):
            fail("GitHub package version entry is invalid")
        version_id = version.get("id")
        digest = version.get("name")
        metadata = version.get("metadata")
        container = metadata.get("container") if isinstance(metadata, dict) else None
        tags = container.get("tags") if isinstance(container, dict) else None
        if (
            not isinstance(version_id, int)
            or version_id <= 0
            or not isinstance(digest, str)
            or not DIGEST.fullmatch(digest)
            or not isinstance(tags, list)
            or any(not isinstance(tag, str) for tag in tags)
        ):
            fail("GitHub package version entry is invalid")
        remote.append({"digest": digest, "id": version_id, "tags": sorted(tags)})

    remote_digests = {version["digest"] for version in remote}
    protected, active_release = protected_digests(
        state_root, accepted, by_revision, image_repository, remote_digests
    )
    accepted_digests = {item["digest"] for item in accepted}
    candidates = sorted(
        (
            version
            for version in remote
            if version["digest"] in accepted_digests and version["digest"] not in protected
        ),
        key=lambda version: (version["digest"], version["id"]),
    )
    protected_output = [
        {"digest": digest, "reasons": sorted(reasons)}
        for digest, reasons in sorted(protected.items())
    ]
    return {
        "acceptedEvidenceCount": len(accepted),
        "activeRelease": active_release,
        "candidateVersions": candidates,
        "protectedDigests": protected_output,
        "remoteAcceptedVersionCount": sum(
            1 for version in remote if version["digest"] in accepted_digests
        ),
        "repository": repository,
        "unknownVersionsLeftUntouched": sum(
            1 for version in remote if version["digest"] not in accepted_digests
        ),
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
        "generatedAt": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace(
            "+00:00", "Z"
        ),
        "schema": 1,
    }
    contents = canonical_bytes(document)
    if len(contents) > 256 * 1024:
        fail("Retention plan exceeded its reviewed size bound")
    temporary = f"{path}.new"
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o440)
    try:
        os.fchmod(descriptor, 0o440)
        offset = 0
        while offset < len(contents):
            offset += os.write(descriptor, contents[offset:])
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.replace(temporary, path)
    fsync_directory(os.path.dirname(path))
    return hashlib.sha256(contents).hexdigest()


def delete_plan(path, expected_hash, current_core, base_url, token):
    if not PLAN_HASH.fullmatch(expected_hash):
        fail("Confirmed retention plan hash is invalid")
    document = load_json(path, 0o440, maximum_bytes=256 * 1024)
    if set(document) != {"core", "generatedAt", "schema"} or document.get("schema") != 1:
        fail("Retention plan schema changed")
    contents = canonical_bytes(document)
    if hashlib.sha256(contents).hexdigest() != expected_hash:
        fail("Confirmed retention plan hash does not match")
    generated_at = utc_timestamp(document.get("generatedAt"))
    now = dt.datetime.now(dt.timezone.utc)
    if generated_at > now or now - generated_at > dt.timedelta(hours=1):
        fail("Retention plan is stale")
    if document.get("core") != current_core:
        fail("GHCR or local protection state changed after the dry run")
    candidates = current_core["candidateVersions"]
    for candidate in candidates:
        with api_request(f"{base_url}/versions/{candidate['id']}", token, method="DELETE") as response:
            if response.status != 204:
                fail("GitHub package deletion did not return 204")
    os.unlink(path)
    fsync_directory(os.path.dirname(path))
    return len(candidates)


def main():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("operation", choices=("delete", "plan"))
    parser.add_argument("--evidence-root", required=True)
    parser.add_argument("--image-repository", required=True)
    parser.add_argument("--owner", required=True)
    parser.add_argument("--package", required=True)
    parser.add_argument("--plan-file", required=True)
    parser.add_argument("--plan-hash", default="")
    parser.add_argument("--scope", required=True)
    parser.add_argument("--state-root", required=True)
    parser.add_argument("--token-file", required=True)
    arguments = parser.parse_args()

    repository = f"{arguments.owner}/{arguments.package}"
    if arguments.image_repository != f"ghcr.io/{repository}":
        fail("GHCR API target and deployment image repository disagree")
    token = read_token(arguments.token_file)
    base_url = package_base_url(arguments.scope, arguments.owner, arguments.package)
    versions = list_versions(base_url, token)
    core = plan_core(
        versions,
        arguments.state_root,
        arguments.evidence_root,
        arguments.image_repository,
        repository,
    )

    if arguments.operation == "plan":
        if arguments.plan_hash:
            fail("Dry-run retention does not accept a plan hash")
        plan_hash = write_plan(arguments.plan_file, core)
        output = {
            "candidateVersions": len(core["candidateVersions"]),
            "operation": "plan",
            "planPath": arguments.plan_file,
            "planSha256": plan_hash,
            "protectedDigests": len(core["protectedDigests"]),
            "repository": repository,
            "unknownVersionsLeftUntouched": core["unknownVersionsLeftUntouched"],
        }
    else:
        deleted = delete_plan(
            arguments.plan_file, arguments.plan_hash, core, base_url, token
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
