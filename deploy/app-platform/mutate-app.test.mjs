import assert from "node:assert/strict";
import { assertDigestOnlyPatch, guardedSpecMutation } from "./mutate-app.mjs";

const oldDigest = `sha256:${"1".repeat(64)}`;
const newDigest = `sha256:${"2".repeat(64)}`;

function app(updatedAt = "2026-08-11T00:00:00Z") {
  return {
    active_deployment: { id: "deployment-active" },
    dedicated_ips: [
      { ip: "192.0.2.10", status: "ASSIGNED" },
      { ip: "192.0.2.11", status: "ASSIGNED" },
    ],
    id: "app-fixture-production",
    in_progress_deployment: null,
    spec: {
      egress: { type: "DEDICATED_IP" },
      jobs: [{ image: { digest: oldDigest }, name: "capstone-migrate" }],
      services: [{ image: { digest: oldDigest }, name: "capstone-chat" }],
    },
    updated_at: updatedAt,
  };
}

{
  const before = app().spec;
  const after = structuredClone(before);
  after.services[0].image.digest = newDigest;
  after.jobs[0].image.digest = newDigest;
  assert.doesNotThrow(() => assertDigestOnlyPatch(before, after, newDigest));
  after.services[0].instance_count = 2;
  assert.throws(
    () => assertDigestOnlyPatch(before, after, newDigest),
    /more than the image digest/u,
  );
}

{
  const initial = app();
  const final = app("2026-08-11T00:01:00Z");
  final.active_deployment.id = "deployment-candidate";
  final.spec.services[0].image.digest = newDigest;
  final.spec.jobs[0].image.digest = newDigest;
  const reads = [initial, structuredClone(initial), final];
  let updated = false;
  const result = await guardedSpecMutation({
    appId: initial.id,
    beforeSubmit: async () => undefined,
    buildExpectedSpec: async (value) => {
      const expected = structuredClone(value.spec);
      expected.services[0].image.digest = newDigest;
      expected.jobs[0].image.digest = newDigest;
      return expected;
    },
    client: {
      getApp: async () => reads.shift(),
      getDeployment: async () => ({ id: "deployment-candidate", phase: "ACTIVE" }),
      updateApp: async (_appId, spec) => {
        updated = true;
        assert.deepEqual(spec, final.spec);
        return { deploymentId: "deployment-candidate" };
      },
    },
    validateFinal: async ({ finalApp }) => assert.equal(finalApp, final),
    waitOptions: { intervalMs: 0, maximumAttempts: 1 },
  });
  assert.equal(updated, true);
  assert.equal(result.deploymentId, "deployment-candidate");
}

{
  const initial = app();
  const final = app("2026-08-11T00:01:00Z");
  final.active_deployment.id = "deployment-candidate";
  final.dedicated_ips[1].ip = "192.0.2.99";
  const reads = [initial, structuredClone(initial), final];
  await assert.rejects(
    guardedSpecMutation({
      appId: initial.id,
      buildExpectedSpec: async (value) => value.spec,
      client: {
        getApp: async () => reads.shift(),
        getDeployment: async () => ({ id: "deployment-candidate", phase: "ACTIVE" }),
        updateApp: async () => ({ deploymentId: "deployment-candidate" }),
      },
      validateFinal: async () => undefined,
      waitOptions: { intervalMs: 0, maximumAttempts: 1 },
    }),
    /egress addresses changed/u,
  );
}

{
  const initial = app();
  const drifted = app("2026-08-11T00:00:01Z");
  let updateCalls = 0;
  await assert.rejects(
    guardedSpecMutation({
      appId: initial.id,
      buildExpectedSpec: async (value) => value.spec,
      client: {
        getApp: async () => {
          if (updateCalls === 0) {
            updateCalls += 1;
            return initial;
          }
          return drifted;
        },
        updateApp: async () => {
          throw new Error("must not update");
        },
      },
      validateFinal: async () => undefined,
    }),
    /changed before submission/u,
  );
}

process.stdout.write("App Platform mutation fixtures passed.\n");
