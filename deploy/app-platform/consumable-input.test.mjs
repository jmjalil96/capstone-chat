import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { withConsumableProtectedInputs } from "./consumable-input.mjs";

const directory = mkdtempSync(path.join(os.tmpdir(), "capstone-consumable-input-"));
try {
  const successPath = path.join(directory, "success.json");
  writeFileSync(successPath, '{"schema":1}\n', { mode: 0o600 });
  chmodSync(successPath, 0o600);
  const value = await withConsumableProtectedInputs(
    [{ label: "Success input", name: "document", path: successPath }],
    async ({ document }) => document.schema,
  );
  assert.equal(value, 1);
  assert.equal(existsSync(successPath), false);

  const failurePath = path.join(directory, "failure.json");
  writeFileSync(failurePath, '{"schema":1}\n', { mode: 0o600 });
  chmodSync(failurePath, 0o600);
  await assert.rejects(
    withConsumableProtectedInputs(
      [{ label: "Failure input", name: "document", path: failurePath }],
      async () => {
        throw new Error("fixture failure");
      },
    ),
    /fixture failure/u,
  );
  assert.equal(existsSync(failurePath), false);

  const invalidPath = path.join(directory, "invalid.json");
  writeFileSync(invalidPath, "not json\n", { mode: 0o600 });
  chmodSync(invalidPath, 0o600);
  await assert.rejects(
    withConsumableProtectedInputs(
      [{ label: "Invalid input", name: "document", path: invalidPath }],
      async () => undefined,
    ),
    /not valid JSON/u,
  );
  assert.equal(existsSync(invalidPath), false);
} finally {
  rmSync(directory, { force: true, recursive: true });
}

process.stdout.write("App Platform consumable input fixtures passed.\n");
