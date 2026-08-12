import { isDeepStrictEqual } from "node:util";
import { captureLiveState, liveFingerprint } from "./contract.mjs";
import { waitForDeployment } from "./provider-api.mjs";

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

export function assertDigestOnlyPatch(before, after, digest) {
  const expected = structuredClone(before);
  for (const collection of [expected.services, expected.jobs]) {
    for (const component of collection ?? []) {
      assert(component?.image?.digest !== undefined, "An image-bearing component has no digest");
      component.image.digest = digest;
    }
  }
  assert(isDeepStrictEqual(expected, after), "Release mutation changed more than the image digest");
}

export function assertNoSpecChange(before, after) {
  assert(isDeepStrictEqual(before, after), "History eviction must not change the App spec");
}

export async function guardedSpecMutation({
  appId,
  beforeSubmit = async () => undefined,
  buildExpectedSpec,
  client,
  validateFinal,
  waitOptions,
}) {
  const initial = await client.getApp(appId);
  assert(initial.id === appId, "Initial App ID does not match the pinned authority");
  assert(initial.in_progress_deployment == null, "Another DigitalOcean deployment is in progress");
  const initialState = captureLiveState(initial);
  const initialFingerprint = liveFingerprint(initial);
  const expectedSpec = await buildExpectedSpec(structuredClone(initial));

  await beforeSubmit();
  const immediate = await client.getApp(appId);
  assert(immediate.in_progress_deployment == null, "Another DigitalOcean deployment started");
  assert(
    liveFingerprint(immediate) === initialFingerprint,
    "Live App state changed before submission",
  );
  const updated = await client.updateApp(appId, expectedSpec);
  assert(
    updated.deploymentId !== initialState.activeDeploymentId,
    "App update reused the active deployment",
  );
  await waitForDeployment(client, appId, updated.deploymentId, waitOptions);

  const finalApp = await client.getApp(appId);
  assert(
    finalApp.in_progress_deployment == null,
    "Completed App still reports an in-progress deployment",
  );
  assert(
    finalApp.active_deployment?.id === updated.deploymentId,
    "Updated deployment did not become active",
  );
  if (initialState.dedicatedIps.length > 0) {
    const finalState = captureLiveState(finalApp);
    assert(
      isDeepStrictEqual(finalState.dedicatedIps, initialState.dedicatedIps),
      "Dedicated egress addresses changed during App mutation",
    );
  }
  await validateFinal({
    deploymentId: updated.deploymentId,
    expectedSpec,
    finalApp,
    initialApp: initial,
  });
  return {
    deploymentId: updated.deploymentId,
    finalFingerprint: liveFingerprint(finalApp),
    initialFingerprint,
  };
}

export async function guardedUnchangedRedeployment({ appId, client, validateFinal, waitOptions }) {
  const initial = await client.getApp(appId);
  assert(initial.id === appId, "Initial App ID does not match the pinned authority");
  assert(initial.in_progress_deployment == null, "Another DigitalOcean deployment is in progress");
  const initialFingerprint = liveFingerprint(initial);
  const initialState = captureLiveState(initial);

  const immediate = await client.getApp(appId);
  assert(immediate.in_progress_deployment == null, "Another DigitalOcean deployment started");
  assert(
    liveFingerprint(immediate) === initialFingerprint,
    "Live App state changed before submission",
  );

  const deployment = await client.createDeployment(appId);
  await waitForDeployment(client, appId, deployment.id, waitOptions);
  const finalApp = await client.getApp(appId);
  assert(finalApp.active_deployment?.id === deployment.id, "Redeployment did not become active");
  assertNoSpecChange(initial.spec, finalApp.spec);
  assert(
    isDeepStrictEqual(captureLiveState(finalApp).dedicatedIps, initialState.dedicatedIps),
    "Dedicated egress addresses changed during unchanged redeployment",
  );
  await validateFinal({ deploymentId: deployment.id, finalApp, initialApp: initial });
  return {
    deploymentId: deployment.id,
    finalFingerprint: liveFingerprint(finalApp),
    initialFingerprint,
  };
}
