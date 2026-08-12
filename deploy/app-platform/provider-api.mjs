import { boundedJson } from "./http-json.mjs";

const API_ORIGIN = "https://api.digitalocean.com";
const REQUEST_TIMEOUT_MS = 20_000;
const MAXIMUM_PAGES = 10;

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function appPath(appId, suffix = "") {
  assert(
    typeof appId === "string" && /^[0-9a-f-]{20,64}$/u.test(appId),
    "DigitalOcean App ID is invalid",
  );
  return `/v2/apps/${encodeURIComponent(appId)}${suffix}`;
}

function listPage(result, key, label, observedCount, expectedTotal) {
  const values = result?.[key];
  const total = result?.meta?.total;
  assert(
    Number.isSafeInteger(total) &&
      total >= 0 &&
      (expectedTotal === undefined || total === expectedTotal),
    `${label} is invalid`,
  );
  if (values === undefined) {
    // DigitalOcean omits an empty collection key while retaining the authoritative total.
    assert(observedCount === total, `${label} is invalid`);
    return { total, values: [] };
  }
  assert(Array.isArray(values), `${label} is invalid`);
  const nextCount = observedCount + values.length;
  assert(
    nextCount <= total && (values.length === 100 || nextCount === total),
    `${label} is invalid`,
  );
  return { total, values };
}

export function createDigitalOceanClient({ fetchImplementation = fetch, token }) {
  assert(typeof token === "string" && token.length >= 32, "DigitalOcean token is missing");

  async function request(path, { body, method = "GET" } = {}) {
    let response;
    try {
      response = await fetchImplementation(new URL(path, API_ORIGIN), {
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        method,
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      fail("DigitalOcean API request failed");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      fail(`DigitalOcean API request failed with status ${response.status}`);
    }
    try {
      return await boundedJson(response, "DigitalOcean API");
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("DigitalOcean API ")) {
        throw error;
      }
      fail("DigitalOcean API returned invalid JSON");
    }
  }

  return {
    async createApp(spec) {
      const result = await request("/v2/apps", { body: { spec }, method: "POST" });
      const app = result?.app;
      assert(
        typeof app?.id === "string" && /^[0-9a-f-]{20,64}$/u.test(app.id),
        "DigitalOcean did not return an App ID",
      );
      const deploymentId = app.in_progress_deployment?.id;
      assert(
        typeof deploymentId === "string" && deploymentId.length >= 8,
        "App creation has no deployment",
      );
      return { app, deploymentId };
    },

    async createDeployment(appId) {
      const result = await request(appPath(appId, "/deployments"), {
        body: { force_build: false },
        method: "POST",
      });
      assert(result?.deployment?.id, "DigitalOcean did not return a deployment ID");
      return result.deployment;
    },

    async getApp(appId) {
      const result = await request(appPath(appId));
      assert(result?.app?.id === appId, "DigitalOcean returned the wrong App");
      return result.app;
    },

    async getDeployment(appId, deploymentId) {
      assert(
        typeof deploymentId === "string" && deploymentId.length >= 8,
        "DigitalOcean deployment ID is invalid",
      );
      const result = await request(
        appPath(appId, `/deployments/${encodeURIComponent(deploymentId)}`),
      );
      assert(result?.deployment?.id === deploymentId, "DigitalOcean returned the wrong deployment");
      return result.deployment;
    },

    async getHealth(appId) {
      const result = await request(appPath(appId, "/health"));
      assert(result?.app_health, "DigitalOcean App health is missing");
      return result.app_health;
    },

    async getExecUrl(appId, deploymentId, componentName, instanceName) {
      assert(
        typeof deploymentId === "string" && deploymentId.length >= 8,
        "DigitalOcean deployment ID is invalid",
      );
      assert(componentName === "capstone-chat", "DigitalOcean console component changed");
      assert(
        typeof instanceName === "string" && /^[a-z0-9-]{8,128}$/u.test(instanceName),
        "DigitalOcean service instance name is invalid",
      );
      const result = await request(
        appPath(
          appId,
          `/deployments/${encodeURIComponent(deploymentId)}/components/${componentName}/exec?instance_name=${encodeURIComponent(instanceName)}`,
        ),
      );
      assert(typeof result?.url === "string", "DigitalOcean exec URL is missing");
      let url;
      try {
        url = new URL(result.url);
      } catch {
        fail("DigitalOcean exec URL is invalid");
      }
      assert(
        url.protocol === "wss:" &&
          url.username === "" &&
          url.password === "" &&
          url.port === "" &&
          url.hash === "" &&
          /^proxy-apps-prod-ric-\d+\.ondigitalocean\.app$/u.test(url.hostname) &&
          url.pathname === "/" &&
          [...url.searchParams.keys()].length === 1 &&
          url.searchParams.has("token") &&
          url.searchParams.get("token").length >= 8,
        "DigitalOcean exec URL is invalid",
      );
      return url.toString();
    },

    async listInstances(appId) {
      const result = await request(appPath(appId, "/instances"));
      assert(Array.isArray(result?.instances), "DigitalOcean instance list is invalid");
      return result.instances;
    },

    async listApps() {
      const apps = [];
      let total;
      for (let page = 1; page <= MAXIMUM_PAGES; page += 1) {
        const result = await request(`/v2/apps?page=${page}&per_page=100`);
        const current = listPage(result, "apps", "DigitalOcean App list", apps.length, total);
        total = current.total;
        apps.push(...current.values);
        if (apps.length === total) return apps;
      }
      fail("DigitalOcean App inventory exceeded its reviewed bound");
    },

    async listDeployments(appId) {
      const deployments = [];
      let total;
      for (let page = 1; page <= MAXIMUM_PAGES; page += 1) {
        const result = await request(appPath(appId, `/deployments?page=${page}&per_page=100`));
        const current = listPage(
          result,
          "deployments",
          "DigitalOcean deployment list",
          deployments.length,
          total,
        );
        total = current.total;
        deployments.push(...current.values);
        if (deployments.length === total) {
          return deployments;
        }
      }
      fail("DigitalOcean deployment history exceeded its reviewed bound");
    },

    async updateApp(appId, spec) {
      const result = await request(appPath(appId), { body: { spec }, method: "PUT" });
      assert(result?.app?.id === appId, "DigitalOcean returned the wrong updated App");
      const deploymentId = result.app.in_progress_deployment?.id;
      assert(
        typeof deploymentId === "string" && deploymentId.length >= 8,
        "App update has no deployment",
      );
      return { app: result.app, deploymentId };
    },
  };
}

export async function waitForDeployment(
  client,
  appId,
  deploymentId,
  {
    intervalMs = 5_000,
    maximumAttempts = 360,
    wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {},
) {
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    const deployment = await client.getDeployment(appId, deploymentId);
    if (deployment.phase === "ACTIVE") {
      return deployment;
    }
    if (["CANCELED", "ERROR"].includes(deployment.phase)) {
      fail("DigitalOcean deployment failed");
    }
    if (attempt + 1 < maximumAttempts) {
      await wait(intervalMs);
    }
  }
  fail("DigitalOcean deployment did not finish within the reviewed timeout");
}
