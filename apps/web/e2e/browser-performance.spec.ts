import { expect, test } from "@playwright/test";

import { copy } from "../src/copy";
import {
  browserUuid,
  installStreamingFixture,
  readStreamingBrowserPerformance,
} from "./support/streaming-fixture";

function percentile(samples: readonly number[], percentileRank: number): number {
  if (samples.length === 0) {
    throw new Error("A percentile requires at least one sample");
  }
  const ordered = [...samples].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(percentileRank * ordered.length) - 1);
  const value = ordered[index];
  if (value === undefined) {
    throw new Error("The requested percentile is outside the available samples");
  }
  return value;
}

test("measures browser stream presentation and cancellation latency against launch targets", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const sampleCount = 20;
  const seeds = Array.from({ length: sampleCount }, (_, index) => ({
    id: browserUuid(10_000 + index),
    title: `Medición de navegador ${index + 1}`,
    streams: [
      {
        deltas: [
          {
            delayMilliseconds: 20,
            text: `Fragmento-medido-${(index + 1).toString().padStart(2, "0")}`,
          },
        ],
        outcome: "hold" as const,
      },
    ],
  }));
  await installStreamingFixture(page, seeds);

  const presentationMilliseconds: number[] = [];
  const localCancellationMilliseconds: number[] = [];
  const backendCancellationMilliseconds: number[] = [];

  for (const [index, seed] of seeds.entries()) {
    await page.goto(`/c/${seed.id}`);
    const draft = page.getByRole("textbox", { name: copy.conversations.draft.label });
    await draft.fill(`Solicitud de medición ${index + 1}`);
    await page.getByRole("button", { name: copy.conversations.generation.actions.send }).click();

    const marker = seed.streams[0]?.deltas[0]?.text;
    if (!marker) {
      throw new Error("The performance fixture is missing its stream marker");
    }
    await expect(page.getByText(marker, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: copy.conversations.generation.actions.stop }).click();
    await expect(
      page
        .locator(".response-outcome")
        .filter({ hasText: copy.conversations.generation.terminal.cancelled }),
    ).toBeVisible();

    const measured = await readStreamingBrowserPerformance(page);
    const presentation = measured.presentations.find((sample) => sample.marker === marker);
    const cancellation = measured.cancellations.at(-1);
    if (
      !presentation ||
      presentation.visibleAt === null ||
      !cancellation ||
      cancellation.localUiAt === null ||
      cancellation.backendObservedAt === null
    ) {
      throw new Error(`The browser did not complete performance sample ${index + 1}`);
    }
    presentationMilliseconds.push(presentation.visibleAt - presentation.receivedAt);
    localCancellationMilliseconds.push(cancellation.localUiAt - cancellation.clickedAt);
    backendCancellationMilliseconds.push(cancellation.backendObservedAt - cancellation.clickedAt);
  }

  const report = {
    sampleCount,
    streamChunkToVisibleDomMilliseconds: {
      p50: percentile(presentationMilliseconds, 0.5),
      p95: percentile(presentationMilliseconds, 0.95),
      samples: presentationMilliseconds,
      targetP95: 100,
    },
    stopClickToLocalUiMilliseconds: {
      p50: percentile(localCancellationMilliseconds, 0.5),
      p95: percentile(localCancellationMilliseconds, 0.95),
      samples: localCancellationMilliseconds,
      targetP95: 100,
    },
    stopClickToMockBackendObservationMilliseconds: {
      p50: percentile(backendCancellationMilliseconds, 0.5),
      p95: percentile(backendCancellationMilliseconds, 0.95),
      samples: backendCancellationMilliseconds,
      targetP95: 500,
    },
  };
  await testInfo.attach("browser-performance-percentiles", {
    body: Buffer.from(JSON.stringify(report, null, 2)),
    contentType: "application/json",
  });

  expect(presentationMilliseconds).toHaveLength(sampleCount);
  expect(localCancellationMilliseconds).toHaveLength(sampleCount);
  expect(backendCancellationMilliseconds).toHaveLength(sampleCount);
  expect(report.streamChunkToVisibleDomMilliseconds.p50).toBeLessThanOrEqual(100);
  expect(report.streamChunkToVisibleDomMilliseconds.p95).toBeLessThanOrEqual(100);
  expect(report.stopClickToLocalUiMilliseconds.p50).toBeLessThanOrEqual(100);
  expect(report.stopClickToLocalUiMilliseconds.p95).toBeLessThanOrEqual(100);
  expect(report.stopClickToMockBackendObservationMilliseconds.p50).toBeLessThanOrEqual(500);
  expect(report.stopClickToMockBackendObservationMilliseconds.p95).toBeLessThanOrEqual(500);
});
