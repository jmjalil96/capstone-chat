import assert from "node:assert/strict";
import { createDigitalOceanClient } from "./provider-api.mjs";

const appId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const deploymentId = "deployment-active";
const instance = "capstone-chat-12345678";

async function execUrl(value) {
  const requests = [];
  const client = createDigitalOceanClient({
    fetchImplementation: async (url, options) => {
      requests.push({ options, url });
      return new Response(JSON.stringify({ url: value }), { status: 200 });
    },
    token: "fixture-digitalocean-token-value-long-enough",
  });
  return {
    requests,
    value: await client.getExecUrl(appId, deploymentId, "capstone-chat", instance),
  };
}

{
  const result = await execUrl(
    "wss://proxy-apps-prod-ric-001.ondigitalocean.app/?token=fixture-exec-token",
  );
  assert.equal(
    result.value,
    "wss://proxy-apps-prod-ric-001.ondigitalocean.app/?token=fixture-exec-token",
  );
  assert.equal(result.requests[0].options.redirect, "error");
  assert.match(result.requests[0].url.pathname, /deployments\/deployment-active\/components/u);
}

{
  const requests = [];
  const client = createDigitalOceanClient({
    fetchImplementation: async (url, options) => {
      requests.push({ options, url });
      return new Response(
        JSON.stringify({
          app: { id: appId, in_progress_deployment: { id: "deployment-created" } },
        }),
        { status: 200 },
      );
    },
    token: "fixture-digitalocean-token-value-long-enough",
  });
  const result = await client.createApp({ name: "fixture" });
  assert.equal(result.deploymentId, "deployment-created");
  assert.equal(requests[0].options.method, "POST");
  assert.equal(requests[0].url.pathname, "/v2/apps");
}

{
  let cancelled = false;
  const body = new ReadableStream({
    cancel() {
      cancelled = true;
    },
    start(controller) {
      controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
    },
  });
  const client = createDigitalOceanClient({
    fetchImplementation: async () => new Response(body, { status: 200 }),
    token: "fixture-digitalocean-token-value-long-enough",
  });
  await assert.rejects(client.getApp(appId), /exceeded its reviewed bound/u);
  assert.equal(cancelled, true);
}

for (const value of [
  "wss://attacker.invalid/?token=fixture-exec-token",
  "ws://proxy-apps-prod-ric-001.ondigitalocean.app/?token=fixture-exec-token",
  "wss://proxy-apps-prod-nyc-001.ondigitalocean.app/?token=fixture-exec-token",
  "wss://proxy-apps-prod-ric-001.ondigitalocean.app/path?token=fixture-exec-token",
  "wss://proxy-apps-prod-ric-001.ondigitalocean.app/?token=fixture-exec-token&extra=value",
]) {
  await assert.rejects(execUrl(value), /exec URL is invalid/u);
}

{
  const client = createDigitalOceanClient({
    fetchImplementation: async () => new Response("x".repeat(2 * 1024 * 1024 + 1), { status: 200 }),
    token: "fixture-digitalocean-token-value-long-enough",
  });
  await assert.rejects(client.getApp(appId), /exceeded its reviewed bound/u);
}

process.stdout.write("App Platform provider API fixtures passed.\n");
