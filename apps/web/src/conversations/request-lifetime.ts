import { useCallback, useLayoutEffect, useMemo, useRef } from "react";

import { useDraftMemory } from "./draft-memory";

interface RequestGeneration {
  active: boolean;
  readonly controllers: Set<AbortController>;
  readonly scopeKey: string;
}

export interface ConversationRequestCapture {
  readonly isCurrent: () => boolean;
  readonly release: () => void;
  readonly signal: AbortSignal;
}

function createRequestGeneration(scopeKey: string): RequestGeneration {
  return { active: true, controllers: new Set(), scopeKey };
}

export function useConversationRequestLifetime(scopeKey: string) {
  const drafts = useDraftMemory();
  const generationRef = useRef<RequestGeneration | undefined>(undefined);
  if (!generationRef.current || generationRef.current.scopeKey !== scopeKey) {
    generationRef.current = createRequestGeneration(scopeKey);
  }
  const generation = generationRef.current;

  useLayoutEffect(() => {
    generation.active = true;
    return () => {
      generation.active = false;
      for (const controller of generation.controllers) {
        controller.abort();
      }
      generation.controllers.clear();
    };
  }, [generation]);

  const capture = useCallback((): ConversationRequestCapture => {
    const controller = new AbortController();
    const session = drafts.capture();
    if (!generation.active || generationRef.current !== generation) {
      controller.abort();
    } else {
      generation.controllers.add(controller);
    }
    return {
      isCurrent: () =>
        generationRef.current === generation &&
        generation.active &&
        generation.controllers.has(controller) &&
        !controller.signal.aborted &&
        drafts.isCurrent(session),
      release: () => {
        controller.abort();
        generation.controllers.delete(controller);
      },
      signal: AbortSignal.any([controller.signal, session]),
    };
  }, [drafts.capture, drafts.isCurrent, generation]);

  return useMemo(() => ({ capture }), [capture]);
}
