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
IMAGE_REPOSITORY = "ghcr.io/capstone-owner/capstone-chat"


def load_program():
    specification = importlib.util.spec_from_file_location("capstone_ghcr_retention", PROGRAM)
    if specification is None or specification.loader is None:
        raise RuntimeError("Retention program could not be loaded")
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


def write_json(path, value, mode=0o440):
    path.write_text(json.dumps(value, sort_keys=True) + "\n", encoding="utf-8")
    path.chmod(mode)


def fixture_regular_file(path, mode):
    status = os.lstat(path)
    if not stat.S_ISREG(status.st_mode) or stat.S_IMODE(status.st_mode) != mode:
        raise RuntimeError("Fixture metadata is unsafe")
    return status


def revision(number):
    return f"{number:040x}"


def digest(number):
    return f"sha256:{number:064x}"


def release_document(number, previous=""):
    return {
        "digest": digest(number),
        "image": f"{IMAGE_REPOSITORY}@{digest(number)}",
        "previousRelease": previous,
        "revision": revision(number),
    }


def main():
    retention = load_program()
    # Repository fixtures run unprivileged; production still enforces UID 0 in regular_file().
    retention.regular_file = fixture_regular_file

    with tempfile.TemporaryDirectory(prefix="capstone-retention-") as temporary:
        root = pathlib.Path(temporary).resolve()
        state = root / "state"
        evidence = root / "evidence"
        releases = state / "releases"
        pins = state / "recovery-pins"
        for directory in (state, evidence, releases, pins):
            directory.mkdir(exist_ok=True)

        accepted_versions = []
        for number in range(1, 10):
            verified_at = dt.datetime(2026, 1, number, tzinfo=dt.timezone.utc)
            evidence_document = {
                "conclusion": "success",
                "digest": digest(number),
                "image": f"{IMAGE_REPOSITORY}@{digest(number)}",
                "previousCompatible": True,
                "revision": revision(number),
                "schema": 1,
                "verifiedAt": verified_at.isoformat().replace("+00:00", "Z"),
                "workflowUrl": f"https://github.com/capstone-owner/capstone-chat/actions/runs/{number}",
            }
            write_json(evidence / f"{revision(number)}.json", evidence_document)
            accepted_versions.append(
                {
                    "id": number,
                    "metadata": {"container": {"tags": [revision(number)]}},
                    "name": digest(number),
                }
            )

        previous_path = releases / revision(3)
        active_path = releases / revision(4)
        previous_path.mkdir()
        active_path.mkdir()
        write_json(previous_path / "release.json", release_document(3))
        write_json(active_path / "release.json", release_document(4, str(previous_path)))
        (state / "active").symlink_to(active_path)
        (pins / revision(2)).write_text("protected\n", encoding="utf-8")
        (pins / revision(2)).chmod(0o440)

        unknown_digest = "sha256:" + "f" * 64
        versions = [
            *accepted_versions,
            {
                "id": 10,
                "metadata": {"container": {"tags": ["manual"]}},
                "name": unknown_digest,
            },
        ]
        core = retention.plan_core(
            versions,
            str(state),
            str(evidence),
            IMAGE_REPOSITORY,
            "capstone-owner/capstone-chat",
        )

        candidate_digests = {item["digest"] for item in core["candidateVersions"]}
        if candidate_digests != {digest(1)}:
            raise RuntimeError("Retention candidate set crossed a protected boundary")
        protected = {item["digest"]: set(item["reasons"]) for item in core["protectedDigests"]}
        if "active" not in protected.get(digest(4), set()):
            raise RuntimeError("Active digest was not protected")
        if "previous" not in protected.get(digest(3), set()):
            raise RuntimeError("Previous digest was not protected")
        if "recovery-pin" not in protected.get(digest(2), set()):
            raise RuntimeError("Recovery-pinned digest was not protected")
        for number in range(5, 10):
            if "recent-five" not in protected.get(digest(number), set()):
                raise RuntimeError("One of the five recent accepted digests was not protected")
        if core["unknownVersionsLeftUntouched"] != 1 or unknown_digest in candidate_digests:
            raise RuntimeError("Unknown GHCR version was not left untouched")

        plan_path = state / "ghcr-retention-plan.json"
        previous_umask = os.umask(0o077)
        try:
            plan_hash = retention.write_plan(str(plan_path), core)
        finally:
            os.umask(previous_umask)
        if stat.S_IMODE(plan_path.stat().st_mode) != 0o440:
            raise RuntimeError("Retention plan mode is not exactly 0440 under a restrictive umask")
        changed_core = copy.deepcopy(core)
        changed_core["unknownVersionsLeftUntouched"] = 2
        try:
            retention.delete_plan(
                str(plan_path),
                plan_hash,
                changed_core,
                "https://api.github.invalid/package",
                "unused-token",
            )
        except RuntimeError as error:
            if str(error) != "GHCR or local protection state changed after the dry run":
                raise
        else:
            raise RuntimeError("Changed retention snapshot did not block deletion")

    print("GHCR retention fixtures passed.")


if __name__ == "__main__":
    main()
