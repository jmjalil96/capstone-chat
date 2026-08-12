#!/usr/bin/env python3
import copy
import datetime as dt
import importlib.util
import json
import os
import pathlib
import stat
import sys
import tempfile

sys.dont_write_bytecode = True

PROGRAM = pathlib.Path(__file__).with_name("ghcr-retention.py")
REPOSITORY = "jmjalil96/capstone-chat"
IMAGE_REPOSITORY = f"ghcr.io/{REPOSITORY}"


def load_program():
    specification = importlib.util.spec_from_file_location("capstone_app_retention", PROGRAM)
    if specification is None or specification.loader is None:
        raise RuntimeError("Retention program could not be loaded")
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


def revision(number):
    return f"{number:040x}"


def digest(number):
    return f"sha256:{number:064x}"


def release(number, previous):
    verified_at = dt.datetime(2026, 1, number, tzinfo=dt.timezone.utc)
    return {
        "ciRunId": number,
        "ciWorkflowUrl": f"https://github.com/{REPOSITORY}/actions/runs/{number}",
        "createdAt": verified_at.isoformat().replace("+00:00", "Z"),
        "createdTimestamp": verified_at,
        "digest": digest(number),
        "digitalOceanAppId": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        "digitalOceanDeploymentId": f"deployment-{number}",
        "githubDeploymentId": number,
        "image": f"{IMAGE_REPOSITORY}@{digest(number)}",
        "operation": "deploy",
        "previousDigest": "" if previous is None else digest(previous),
        "previousRevision": "" if previous is None else revision(previous),
        "revision": revision(number),
        "schema": 2,
        "type": "release",
    }


def version(number):
    return {
        "id": number,
        "metadata": {"container": {"tags": [revision(number)]}},
        "name": digest(number),
    }


class Response:
    def __init__(self, status=204, body=b""):
        self.status = status
        self.body = body
        self.offset = 0

    def __enter__(self):
        return self

    def __exit__(self, *_arguments):
        return False

    def read(self, size=-1):
        if size < 0:
            size = len(self.body) - self.offset
        value = self.body[self.offset : self.offset + size]
        self.offset += len(value)
        return value


def main():
    retention = load_program()
    releases = [release(number, number - 1 if number > 1 else None) for number in range(9, 0, -1)]
    versions = [version(number) for number in range(1, 10)]
    versions.append(
        {
            "id": 10,
            "metadata": {"container": {"tags": ["manual"]}},
            "name": "sha256:" + "f" * 64,
        }
    )
    versions.append({"id": "malformed"})
    app = {
        "activeDeploymentId": "deployment-9",
        "activeDigest": digest(9),
        "appId": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        "dedicatedIps": ["192.0.2.10", "192.0.2.11"],
        "desiredDigest": digest(9),
        "inProgressDeploymentId": "deployment-candidate",
        "inProgressDigest": digest(8),
        "updatedAt": "2026-08-11T00:00:00Z",
    }
    steady_spec = {
        "jobs": [
            {
                "image": {
                    "digest": digest(9),
                    "registry": "jmjalil96",
                    "registry_type": "GHCR",
                    "repository": "capstone-chat",
                }
            }
        ],
        "services": [
            {
                "image": {
                    "digest": digest(9),
                    "registry": "jmjalil96",
                    "registry_type": "GHCR",
                    "repository": "capstone-chat",
                }
            }
        ],
    }
    if retention.component_digest(steady_spec, IMAGE_REPOSITORY) != digest(9):
        raise RuntimeError("App Platform GHCR authority was not recognized")
    wrong_registry = copy.deepcopy(steady_spec)
    wrong_registry["services"][0]["image"]["registry"] = "ghcr.io"
    try:
        retention.component_digest(wrong_registry, IMAGE_REPOSITORY)
    except RuntimeError as error:
        if str(error) != "DigitalOcean deployment image authority changed":
            raise
    else:
        raise RuntimeError("Legacy GHCR registry shape did not fail closed")
    pins = [{"digest": digest(4), "revision": revision(4)}]
    core = retention.plan_core(versions, app, releases, pins, REPOSITORY)
    candidates = {item["digest"] for item in core["candidateVersions"]}
    if candidates != {digest(1), digest(2), digest(3)}:
        raise RuntimeError("Retention candidates crossed a protection boundary")
    protected = {item["digest"]: set(item["reasons"]) for item in core["protectedDigests"]}
    expected_reasons = {
        digest(9): {"active-serving", "desired-spec", "recent-five"},
        digest(8): {"in-progress", "previous", "recent-five"},
        digest(4): {"recovery-pin"},
    }
    for protected_digest, reasons in expected_reasons.items():
        if not reasons.issubset(protected.get(protected_digest, set())):
            raise RuntimeError("Retention protection reason is missing")
    for number in range(5, 10):
        if "recent-five" not in protected.get(digest(number), set()):
            raise RuntimeError("One of the five recent releases was not protected")
    if core["unknownVersionsLeftUntouched"] != 2:
        raise RuntimeError("Unknown and malformed versions were not left untouched")

    remaining_versions = [item for item in versions if item.get("name") not in candidates]
    second_core = retention.plan_core(remaining_versions, app, releases, pins, REPOSITORY)
    if second_core["candidateVersions"]:
        raise RuntimeError("A later retention plan attempted to delete an already absent version")

    baseline_release = release(9, None)
    baseline_core = retention.plan_core(
        [version(9)],
        {**app, "inProgressDeploymentId": None, "inProgressDigest": None},
        [baseline_release],
        [],
        REPOSITORY,
    )
    if baseline_core["candidateVersions"]:
        raise RuntimeError("Initial baseline invented a predecessor or deletion candidate")

    try:
        retention.plan_core(
            [version(8)],
            {**app, "inProgressDeploymentId": None, "inProgressDigest": None},
            [baseline_release],
            [],
            REPOSITORY,
        )
    except RuntimeError as error:
        if str(error) != "Protected release lacks its exact GHCR full-revision tag":
            raise
    else:
        raise RuntimeError("Missing protected GHCR evidence did not fail closed")

    duplicate = [version(1), version(1)]
    known, unknown = retention.parse_inventory(duplicate)
    if len(known) != 1 or unknown != 1:
        raise RuntimeError("Duplicate package evidence was not left untouched")

    previous_list_pages = retention.json_request
    retention.json_request = lambda *_arguments: [version(1)] * retention.PAGE_SIZE
    try:
        retention.list_pages("https://api.github.invalid/versions", "unused")
    except RuntimeError as error:
        if str(error) != "Provider inventory exceeded the reviewed pagination bound":
            raise
    else:
        raise RuntimeError("Pagination overflow did not fail closed")
    finally:
        retention.json_request = previous_list_pages

    class RedirectingOpener:
        def __init__(self):
            self.calls = 0

        def open(self, request, timeout):
            self.calls += 1
            if request.get_header("Authorization") != "Bearer credential-bearing-token":
                raise RuntimeError("Bearer credential was not attached to the original request")
            if timeout != 20:
                raise RuntimeError("Provider request timeout changed")
            raise retention.urllib.error.HTTPError(
                request.full_url,
                302,
                "Found",
                {"Location": "https://attacker.invalid/collect"},
                None,
            )

    redirecting_opener = RedirectingOpener()
    original_opener = retention.NO_REDIRECT_OPENER
    retention.NO_REDIRECT_OPENER = redirecting_opener
    try:
        retention.api_request(
            "https://api.github.invalid/credential-bearing",
            "credential-bearing-token",
        )
    except RuntimeError as error:
        if str(error) != "Provider API request failed with status 302":
            raise
    else:
        raise RuntimeError("Credential-bearing redirect did not fail closed")
    finally:
        retention.NO_REDIRECT_OPENER = original_opener
    if redirecting_opener.calls != 1:
        raise RuntimeError("Credential-bearing redirect attempted a second request")

    original_request = retention.api_request
    retention.api_request = lambda *_arguments, **_keywords: Response(
        body=b"x" * (retention.MAXIMUM_RESPONSE_BYTES + 1)
    )
    try:
        retention.json_request("https://api.github.invalid/oversize", "unused")
    except RuntimeError as error:
        if str(error) != "Provider API response exceeded its reviewed bound":
            raise
    else:
        raise RuntimeError("Oversized provider JSON response did not fail closed")
    finally:
        retention.api_request = original_request

    with tempfile.TemporaryDirectory(prefix="capstone-app-retention-") as temporary:
        retention.protected_main_head = lambda *_arguments: revision(9)
        root = pathlib.Path(temporary)
        plan_path = root / "plan.json"
        plan_hash = retention.write_plan(str(plan_path), core)
        if stat.S_IMODE(plan_path.stat().st_mode) != 0o600:
            raise RuntimeError("Retention plan mode is not 0600")

        drift_cases = {
            "App spec": ("appAuthority", "updatedAt", "2026-08-11T00:00:01Z"),
            "production Deployment": ("releases", 0, {**core["releases"][0], "operation": "rollback"}),
            "recovery pin": ("recoveryPins", 0, {"digest": digest(3), "revision": revision(3)}),
            "package inventory": ("inventoryCount", None, core["inventoryCount"] + 1),
        }
        for label, (key, nested, value) in drift_cases.items():
            changed = copy.deepcopy(core)
            if nested is None:
                changed[key] = value
            elif isinstance(changed[key], list):
                changed[key][nested] = value
            else:
                changed[key][nested] = value
            try:
                retention.delete_plan(
                    str(plan_path),
                    plan_hash,
                    changed,
                    "https://api.github.invalid/package",
                    "unused",
                    REPOSITORY,
                    "unused-github",
                    revision(9),
                )
            except RuntimeError as error:
                if str(error) != "Provider or recovery protection state changed after the dry run":
                    raise
            else:
                raise RuntimeError(f"{label} drift did not block deletion")

        calls = 0

        def partial_delete(*_arguments, **_keywords):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise RuntimeError("fixture provider failure")
            return Response()

        original_request = retention.api_request
        retention.api_request = partial_delete
        try:
            retention.delete_plan(
                str(plan_path),
                plan_hash,
                core,
                "https://api.github.invalid/package",
                "unused",
                REPOSITORY,
                "unused-github",
                revision(9),
            )
        except retention.PartialDeleteError as error:
            if error.deleted != 1 or not plan_path.exists():
                raise RuntimeError("Partial deletion evidence was not preserved") from error
        else:
            raise RuntimeError("Partial provider failure did not fail closed")
        finally:
            retention.api_request = original_request

        authority_reads = 0

        def moving_main(*_arguments):
            nonlocal authority_reads
            authority_reads += 1
            return revision(9 if authority_reads == 1 else 10)

        retention.protected_main_head = moving_main
        retention.api_request = lambda *_arguments, **_keywords: Response()
        try:
            retention.delete_plan(
                str(plan_path),
                plan_hash,
                core,
                "https://api.github.invalid/package",
                "unused",
                REPOSITORY,
                "unused-github",
                revision(9),
            )
        except retention.PartialDeleteError as error:
            if error.deleted != 1 or not plan_path.exists():
                raise RuntimeError("Main movement did not stop retention safely") from error
        else:
            raise RuntimeError("Stale retention tooling continued deleting")
        finally:
            retention.api_request = original_request
            retention.protected_main_head = lambda *_arguments: revision(9)

        plan_path.unlink()
        second_hash = retention.write_plan(str(plan_path), core)
        retention.api_request = lambda *_arguments, **_keywords: Response()
        try:
            deleted = retention.delete_plan(
                str(plan_path),
                second_hash,
                core,
                "https://api.github.invalid/package",
                "unused",
                REPOSITORY,
                "unused-github",
                revision(9),
            )
        finally:
            retention.api_request = original_request
        if deleted != 3 or plan_path.exists():
            raise RuntimeError("Approved retention plan did not delete exactly its candidates")

        pins_path = root / "pins.json"
        pins_path.write_text(
            json.dumps({"pins": pins, "schema": 1}) + "\n", encoding="utf-8"
        )
        pins_path.chmod(0o600)
        if retention.recovery_pins(str(pins_path), releases) != pins:
            raise RuntimeError("Recovery pin authority was not validated")
        pins_path.write_text(json.dumps({"pins": [], "schema": 2}) + "\n", encoding="utf-8")
        try:
            retention.recovery_pins(str(pins_path), releases)
        except RuntimeError as error:
            if str(error) != "Recovery pin authority schema changed":
                raise
        else:
            raise RuntimeError("Changed recovery pin schema did not fail closed")

    print("App Platform GHCR retention fixtures passed.")


if __name__ == "__main__":
    main()
