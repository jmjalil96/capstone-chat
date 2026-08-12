import { DIGEST_PATTERN, REVISION_PATTERN } from "./contract.mjs";
import { boundedJson } from "./http-json.mjs";

const API_ORIGIN = "https://api.github.com";
const MAXIMUM_PAGES = 10;
const REQUEST_TIMEOUT_MS = 20_000;

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function repositoryPath(repository, suffix = "") {
  assert(
    typeof repository === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository),
    "GitHub repository is invalid",
  );
  return `/repos/${repository}${suffix}`;
}

function githubTimestamp(value, label) {
  const timestamp = typeof value === "string" ? Date.parse(value) : Number.NaN;
  const normalized = Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "";
  assert(
    value === normalized || value === normalized.replace(".000Z", "Z"),
    `${label} timestamp is invalid`,
  );
  return timestamp;
}

function validateReleasePayload(payload, repository) {
  assert(
    payload !== null && typeof payload === "object" && !Array.isArray(payload),
    "Release payload is invalid",
  );
  const keys = Object.keys(payload).sort();
  const expected = [
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
  ].sort();
  assert(
    keys.length === expected.length && keys.every((key, index) => key === expected[index]),
    "Release payload schema changed",
  );
  assert(
    payload.schema === 2 && payload.type === "release",
    "Deployment is not an accepted release",
  );
  assert(
    ["deploy", "initial", "rollback"].includes(payload.operation),
    "Release operation is invalid",
  );
  assert(REVISION_PATTERN.test(payload.revision), "Release revision is invalid");
  assert(DIGEST_PATTERN.test(payload.digest), "Release digest is invalid");
  assert(
    payload.image === `ghcr.io/${repository}@${payload.digest}`,
    "Release image authority is invalid",
  );
  assert(
    (payload.previousRevision === "" && payload.previousDigest === "") ||
      (REVISION_PATTERN.test(payload.previousRevision) &&
        DIGEST_PATTERN.test(payload.previousDigest)),
    "Release predecessor is invalid",
  );
  assert(Number.isSafeInteger(payload.ciRunId) && payload.ciRunId > 0, "Release CI run is invalid");
  assert(
    payload.ciWorkflowUrl === `https://github.com/${repository}/actions/runs/${payload.ciRunId}`,
    "Release CI URL is invalid",
  );
  assert(
    typeof payload.digitalOceanAppId === "string" && payload.digitalOceanAppId.length >= 8,
    "Release App ID is invalid",
  );
  assert(
    typeof payload.digitalOceanDeploymentId === "string" &&
      payload.digitalOceanDeploymentId.length >= 8,
    "Release deployment ID is invalid",
  );
  return payload;
}

export function createGitHubClient({ fetchImplementation = fetch, repository, token }) {
  assert(typeof token === "string" && token.length >= 20, "GitHub API token is missing");

  async function request(path, { body, method = "GET" } = {}) {
    let response;
    try {
      response = await fetchImplementation(new URL(path, API_ORIGIN), {
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        method,
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      fail("GitHub API request failed");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      fail(`GitHub API request failed with status ${response.status}`);
    }
    try {
      return await boundedJson(response, "GitHub API");
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("GitHub API ")) {
        throw error;
      }
      fail("GitHub API returned invalid JSON");
    }
  }

  async function list(path, key) {
    const values = [];
    for (let page = 1; page <= MAXIMUM_PAGES; page += 1) {
      const separator = path.includes("?") ? "&" : "?";
      const result = await request(`${path}${separator}per_page=100&page=${page}`);
      const pageValues = key === undefined ? result : result?.[key];
      assert(Array.isArray(pageValues), "GitHub API list is invalid");
      values.push(...pageValues);
      if (pageValues.length < 100) {
        return values;
      }
    }
    fail("GitHub API pagination exceeded its reviewed bound");
  }

  return {
    async assertStrictForward(activeRevision, candidateRevision) {
      assert(REVISION_PATTERN.test(activeRevision), "Active revision is invalid");
      assert(REVISION_PATTERN.test(candidateRevision), "Candidate revision is invalid");
      assert(
        activeRevision !== candidateRevision,
        "Normal deployment cannot redeploy the active revision",
      );
      const comparison = await request(
        repositoryPath(repository, `/compare/${activeRevision}...${candidateRevision}`),
      );
      assert(
        comparison?.status === "ahead" &&
          comparison?.base_commit?.sha === activeRevision &&
          comparison?.merge_base_commit?.sha === activeRevision &&
          comparison?.commits?.at(-1)?.sha === candidateRevision,
        "Candidate is not a strict descendant of the active revision",
      );
    },

    async createSuccessfulRelease(payload) {
      validateReleasePayload(payload, repository);
      const deployment = await request(repositoryPath(repository, "/deployments"), {
        body: {
          auto_merge: false,
          description: `Capstone Chat production ${payload.operation}`,
          environment: "production",
          payload,
          production_environment: true,
          ref: payload.revision,
          required_contexts: [],
        },
        method: "POST",
      });
      assert(Number.isSafeInteger(deployment?.id), "GitHub did not return a Deployment ID");
      return deployment.id;
    },

    async getMainHead() {
      const result = await request(repositoryPath(repository, "/git/ref/heads/main"));
      const revision = result?.object?.sha;
      assert(
        typeof revision === "string" && REVISION_PATTERN.test(revision),
        "Protected main HEAD is invalid",
      );
      return revision;
    },

    async getContainerDigestForRevision(revision) {
      assert(REVISION_PATTERN.test(revision), "Container revision is invalid");
      const [owner, packageName] = repository.split("/");
      const versions = await list(
        `/users/${encodeURIComponent(owner)}/packages/container/${encodeURIComponent(packageName)}/versions`,
      );
      const matching = versions.filter(
        (version) =>
          Array.isArray(version?.metadata?.container?.tags) &&
          version.metadata.container.tags.includes(revision),
      );
      assert(matching.length === 1, "Revision tag has no unique GHCR package version");
      const digest = matching[0]?.name;
      assert(
        typeof digest === "string" && DIGEST_PATTERN.test(digest),
        "GHCR package digest is invalid",
      );
      return digest;
    },

    async listAcceptedReleases() {
      const deployments = await list(
        repositoryPath(repository, "/deployments?environment=production"),
      );
      const releases = [];
      for (const deployment of deployments) {
        if (deployment?.payload?.type !== "release") {
          continue;
        }
        const payload = validateReleasePayload(deployment.payload, repository);
        assert(
          Number.isSafeInteger(deployment.id) && deployment.id > 0,
          "GitHub Deployment ID is invalid",
        );
        assert(
          deployment.ref === payload.revision && deployment.environment === "production",
          "GitHub Deployment authority is inconsistent",
        );
        const createdTimestamp = githubTimestamp(deployment.created_at, "GitHub Deployment");
        releases.push({
          createdAt: deployment.created_at,
          createdTimestamp,
          deploymentId: deployment.id,
          ...payload,
        });
      }
      releases.sort((left, right) => right.createdTimestamp - left.createdTimestamp);
      for (let index = 1; index < releases.length; index += 1) {
        assert(
          releases[index - 1].createdTimestamp !== releases[index].createdTimestamp,
          "Accepted release order is ambiguous",
        );
      }
      return releases.map(({ createdTimestamp: _createdTimestamp, ...release }) => release);
    },

    async requireSuccessfulCi(revision) {
      assert(REVISION_PATTERN.test(revision), "Candidate revision is invalid");
      const runs = await list(
        repositoryPath(
          repository,
          `/actions/workflows/ci.yml/runs?event=push&head_sha=${revision}&status=completed`,
        ),
        "workflow_runs",
      );
      const accepted = runs.find(
        (run) =>
          run?.name === "CI" &&
          run?.path === ".github/workflows/ci.yml" &&
          run?.conclusion === "success" &&
          run?.head_branch === "main" &&
          run?.head_sha === revision,
      );
      assert(accepted !== undefined, "Candidate has no successful protected-main CI run");
      assert(Number.isSafeInteger(accepted.id), "CI run ID is invalid");
      return {
        id: accepted.id,
        url: `https://github.com/${repository}/actions/runs/${accepted.id}`,
      };
    },
  };
}

export { validateReleasePayload };
