import { afterEach, describe, expect, it, vi } from "vitest";
import { DurableGenerationAuthority } from "../src/generations/durable-authority.js";
import type { DurableGenerationState } from "../src/generations/service.js";

const activeState: DurableGenerationState = {
  assistantMessageId: "00000000-0000-4000-8000-000000000001",
  conversationId: "00000000-0000-4000-8000-000000000002",
  errorCode: null,
  reason: null,
  revision: 1,
  status: "active",
};

const cancelledState: DurableGenerationState = {
  ...activeState,
  reason: "cancelled",
  revision: 2,
  status: "cancelled",
};

describe("durable generation authority", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces reads, reuses a fresh active state, and makes terminal state sticky", async () => {
    let now = 0;
    const firstRead = Promise.withResolvers<DurableGenerationState | null>();
    const readState = vi
      .fn<() => Promise<DurableGenerationState | null>>()
      .mockImplementationOnce(() => firstRead.promise)
      .mockResolvedValueOnce(cancelledState);
    const authority = new DurableGenerationAuthority({
      intervalMilliseconds: 250,
      now: () => now,
      readState,
    });
    authority.startMonitor(() => undefined);

    const first = authority.stateForEvent();
    const coalesced = authority.stateForEvent();
    expect(readState).toHaveBeenCalledOnce();
    firstRead.resolve(activeState);
    await expect(Promise.all([first, coalesced])).resolves.toEqual([activeState, activeState]);

    now = 249;
    await expect(authority.stateForEvent()).resolves.toBe(activeState);
    expect(readState).toHaveBeenCalledOnce();

    now = 250;
    await expect(authority.stateForEvent()).resolves.toBe(cancelledState);
    now = 1_000;
    await expect(authority.stateForEvent(true)).resolves.toBe(cancelledState);
    expect(readState).toHaveBeenCalledTimes(2);

    await authority.stop();
  });

  it("does not make cached active authority fresh after a failed background read", async () => {
    vi.useFakeTimers();
    let now = 0;
    const eventRetry = Promise.withResolvers<DurableGenerationState | null>();
    const readState = vi
      .fn<() => Promise<DurableGenerationState | null>>()
      .mockResolvedValueOnce(activeState)
      .mockRejectedValueOnce(new Error("synthetic durable read failure"))
      .mockImplementationOnce(() => eventRetry.promise);
    const authority = new DurableGenerationAuthority({
      intervalMilliseconds: 250,
      now: () => now,
      readState,
    });
    authority.startMonitor(() => undefined);
    await vi.advanceTimersByTimeAsync(249);
    expect(readState).not.toHaveBeenCalled();

    now = 250;
    await vi.advanceTimersByTimeAsync(1);
    expect(readState).toHaveBeenCalledOnce();

    now = 500;
    await vi.advanceTimersByTimeAsync(250);
    expect(readState).toHaveBeenCalledTimes(2);

    let eventSettled = false;
    const eventState = authority.stateForEvent().then((state) => {
      eventSettled = true;
      return state;
    });
    await Promise.resolve();
    expect(readState).toHaveBeenCalledTimes(3);
    expect(eventSettled).toBe(false);

    eventRetry.resolve(activeState);
    await expect(eventState).resolves.toBe(activeState);
    await authority.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts a post-barrier read when force races an older in-flight snapshot", async () => {
    const staleRead = Promise.withResolvers<DurableGenerationState | null>();
    const postBarrierRead = Promise.withResolvers<DurableGenerationState | null>();
    const readState = vi
      .fn<() => Promise<DurableGenerationState | null>>()
      .mockImplementationOnce(() => staleRead.promise)
      .mockImplementationOnce(() => postBarrierRead.promise);
    const authority = new DurableGenerationAuthority({
      intervalMilliseconds: 250,
      readState,
    });

    const earlier = authority.stateForEvent();
    const forced = authority.stateForEvent(true);
    expect(readState).toHaveBeenCalledOnce();

    staleRead.resolve(activeState);
    await expect(earlier).resolves.toBe(activeState);
    await vi.waitFor(() => expect(readState).toHaveBeenCalledTimes(2));

    let forcedSettled = false;
    void forced.finally(() => {
      forcedSettled = true;
    });
    await Promise.resolve();
    expect(forcedSettled).toBe(false);

    postBarrierRead.resolve(cancelledState);
    await expect(forced).resolves.toBe(cancelledState);
    await authority.stop();
  });
});
