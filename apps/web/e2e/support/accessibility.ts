import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, type TestInfo } from "@playwright/test";

const acceptedLowerImpactFindings: Readonly<Record<string, Readonly<Record<string, string>>>> =
  Object.freeze({});

export async function expectReviewedWcagState(
  page: Page,
  testInfo: TestInfo,
  state: string,
): Promise<void> {
  const tags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
  const result = await new AxeBuilder({ page }).withTags(tags).analyze();
  const findings = result.violations.map(
    ({ description, help, helpUrl, id, impact, nodes, tags: findingTags }) => ({
      description,
      help,
      helpUrl,
      id,
      impact,
      tags: findingTags,
      nodes: nodes.map((node) => ({
        failureSummary: node.failureSummary,
        html: node.html,
        target: node.target,
      })),
      disposition: acceptedLowerImpactFindings[state]?.[id] ?? null,
    }),
  );
  await testInfo.attach(`axe-${state}`, {
    body: Buffer.from(JSON.stringify({ state, tags, findings }, null, 2)),
    contentType: "application/json",
  });

  const blocking = result.violations
    .filter(({ impact }) => impact === "serious" || impact === "critical")
    .map(({ help, id, impact, nodes }) => ({
      help,
      id,
      impact,
      targets: nodes.map((node) => node.target),
    }));
  const accepted = acceptedLowerImpactFindings[state] ?? {};
  const lowerImpactIds = result.violations
    .filter(({ impact }) => impact !== "serious" && impact !== "critical")
    .map(({ id }) => id)
    .sort();
  const acceptedIds = Object.keys(accepted).sort();

  expect(blocking, `${state} has serious or critical axe findings`).toEqual([]);
  expect(
    lowerImpactIds,
    `${state} has untriaged lower-impact axe findings; document each disposition explicitly`,
  ).toEqual(acceptedIds);
}
