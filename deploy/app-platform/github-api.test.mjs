import assert from "node:assert/strict";
import { createGitHubClient, validateReleasePayload } from "./github-api.mjs";

const repository = "jmjalil96/capstone-chat";
const activeRevision = "a".repeat(40);
const candidateRevision = "b".repeat(40);
const digest = `sha256:${"c".repeat(64)}`;

function payload() {
  return {
    ciRunId: 42,
    ciWorkflowUrl: `https://github.com/${repository}/actions/runs/42`,
    digest,
    digitalOceanAppId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    digitalOceanDeploymentId: "deployment-candidate",
    image: `ghcr.io/${repository}@${digest}`,
    operation: "deploy",
    previousDigest: `sha256:${"d".repeat(64)}`,
    previousRevision: activeRevision,
    revision: candidateRevision,
    schema: 2,
    type: "release",
  };
}

assert.deepEqual(validateReleasePayload(payload(), repository), payload());
assert.doesNotThrow(() =>
  validateReleasePayload(
    {
      ...payload(),
      operation: "initial",
      previousDigest: "",
      previousRevision: "",
    },
    repository,
  ),
);
assert.throws(
  () => validateReleasePayload({ ...payload(), type: "history-eviction" }, repository),
  /not an accepted release/u,
);

{
  const requests = [];
  const client = createGitHubClient({
    fetchImplementation: async (url) => {
      requests.push(url.pathname);
      return new Response(
        JSON.stringify({
          workflow_runs: [
            {
              conclusion: "success",
              head_branch: "main",
              head_sha: candidateRevision,
              id: 42,
              name: "CI",
              path: ".github/workflows/ci.yml",
            },
          ],
        }),
        { status: 200 },
      );
    },
    repository,
    token: "fixture-github-token-value-long-enough",
  });
  assert.deepEqual(await client.requireSuccessfulCi(candidateRevision), {
    id: 42,
    url: `https://github.com/${repository}/actions/runs/42`,
  });
  assert.match(requests[0], /actions\/workflows\/ci\.yml\/runs/u);

  const impostor = createGitHubClient({
    fetchImplementation: async () =>
      new Response(
        JSON.stringify({
          workflow_runs: [
            {
              conclusion: "success",
              head_branch: "main",
              head_sha: candidateRevision,
              id: 43,
              name: "CI",
              path: ".github/workflows/impostor.yml",
            },
          ],
        }),
        { status: 200 },
      ),
    repository,
    token: "fixture-github-token-value-long-enough",
  });
  await assert.rejects(impostor.requireSuccessfulCi(candidateRevision), /no successful/u);
}

{
  const requests = [];
  const client = createGitHubClient({
    fetchImplementation: async (url) => {
      requests.push(url.pathname);
      return new Response(
        JSON.stringify([
          {
            metadata: { container: { tags: [candidateRevision] } },
            name: digest,
          },
        ]),
        { status: 200 },
      );
    },
    repository,
    token: "fixture-github-token-value-long-enough",
  });
  assert.equal(await client.getContainerDigestForRevision(candidateRevision), digest);
  assert.equal(requests[0], "/users/jmjalil96/packages/container/capstone-chat/versions");

  for (const versions of [
    [],
    [
      { metadata: { container: { tags: [candidateRevision] } }, name: digest },
      {
        metadata: { container: { tags: [candidateRevision] } },
        name: `sha256:${"d".repeat(64)}`,
      },
    ],
  ]) {
    const invalid = createGitHubClient({
      fetchImplementation: async () => new Response(JSON.stringify(versions), { status: 200 }),
      repository,
      token: "fixture-github-token-value-long-enough",
    });
    await assert.rejects(
      invalid.getContainerDigestForRevision(candidateRevision),
      /no unique GHCR package version/u,
    );
  }
}

{
  const responses = [
    {
      body: { object: { sha: candidateRevision } },
      status: 200,
    },
    {
      body: {
        base_commit: { sha: activeRevision },
        commits: [{ sha: candidateRevision }],
        merge_base_commit: { sha: activeRevision },
        status: "ahead",
      },
      status: 200,
    },
  ];
  const client = createGitHubClient({
    fetchImplementation: async () => {
      const value = responses.shift();
      return new Response(JSON.stringify(value.body), { status: value.status });
    },
    repository,
    token: "fixture-github-token-value-long-enough",
  });
  assert.equal(await client.getMainHead(), candidateRevision);
  await assert.doesNotReject(client.assertStrictForward(activeRevision, candidateRevision));
}

{
  const olderPayload = {
    ...payload(),
    digest: `sha256:${"d".repeat(64)}`,
    image: `ghcr.io/${repository}@sha256:${"d".repeat(64)}`,
    previousDigest: "",
    previousRevision: "",
    revision: activeRevision,
  };
  const deployments = [
    {
      created_at: "2026-08-11T00:00:00Z",
      environment: "production",
      id: 10,
      payload: olderPayload,
      ref: activeRevision,
    },
    {
      created_at: "2026-08-11T00:00:01Z",
      environment: "production",
      id: 11,
      payload: payload(),
      ref: candidateRevision,
    },
  ];
  const responses = [deployments];
  const client = createGitHubClient({
    fetchImplementation: async () =>
      new Response(JSON.stringify(responses.shift()), { status: 200 }),
    repository,
    token: "fixture-github-token-value-long-enough",
  });
  const accepted = await client.listAcceptedReleases();
  assert.deepEqual(
    accepted.map((release) => release.deploymentId),
    [11, 10],
  );

  for (const createdAt of ["not-a-date", "2026-08-11T00:00:00Z"]) {
    const changed = structuredClone(deployments);
    changed[1].created_at = createdAt;
    const repeated = [changed];
    const ambiguous = createGitHubClient({
      fetchImplementation: async () =>
        new Response(JSON.stringify(repeated.shift()), { status: 200 }),
      repository,
      token: "fixture-github-token-value-long-enough",
    });
    await assert.rejects(
      ambiguous.listAcceptedReleases(),
      createdAt === "not-a-date" ? /timestamp is invalid/u : /order is ambiguous/u,
    );
  }

  const requested = [];
  const withoutStatuses = createGitHubClient({
    fetchImplementation: async (url) => {
      requested.push(url.pathname);
      return new Response(JSON.stringify(deployments), { status: 200 });
    },
    repository,
    token: "fixture-github-token-value-long-enough",
  });
  assert.equal((await withoutStatuses.listAcceptedReleases()).length, 2);
  assert.equal(
    requested.some((value) => value.endsWith("/statuses")),
    false,
  );
}

{
  const client = createGitHubClient({
    fetchImplementation: async () =>
      new Response(
        JSON.stringify({
          base_commit: { sha: activeRevision },
          commits: [{ sha: candidateRevision }],
          merge_base_commit: { sha: "e".repeat(40) },
          status: "diverged",
        }),
        { status: 200 },
      ),
    repository,
    token: "fixture-github-token-value-long-enough",
  });
  await assert.rejects(
    client.assertStrictForward(activeRevision, candidateRevision),
    /not a strict descendant/u,
  );
}

process.stdout.write("App Platform GitHub authority fixtures passed.\n");
