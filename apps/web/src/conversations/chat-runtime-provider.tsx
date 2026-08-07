import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
} from "react";

import { ChatRuntime, type ChatRuntimeSnapshot } from "./chat-runtime";
import { useDraftMemory } from "./draft-memory";

const ChatRuntimeContext = createContext<ChatRuntime | null>(null);
const subscribeToNothing = (): (() => void) => () => undefined;
const noRuntimeSnapshot = (): undefined => undefined;

interface ChatRuntimeProviderProps {
  readonly children: ReactNode;
}

export function ChatRuntimeProvider({ children }: ChatRuntimeProviderProps) {
  const queryClient = useQueryClient();
  const drafts = useDraftMemory();
  const authSignal = drafts.capture();
  const runtime = useMemo(
    () =>
      new ChatRuntime({
        authSignal,
        isAuthCurrent: () => drafts.isCurrent(authSignal),
        queryClient,
        queryScope: drafts.queryScope,
      }),
    [authSignal, drafts.isCurrent, drafts.queryScope, queryClient],
  );
  const generation = useMemo(() => ({ active: false, runtime }), [runtime]);

  useLayoutEffect(() => {
    generation.active = true;
    return () => {
      generation.active = false;
      queueMicrotask(() => {
        // React replays effects in development; dispose only a generation that stayed inactive.
        if (!generation.active) {
          generation.runtime.dispose();
        }
      });
    };
  }, [generation]);

  return <ChatRuntimeContext.Provider value={runtime}>{children}</ChatRuntimeContext.Provider>;
}

export function useChatRuntime(): ChatRuntime {
  const runtime = useContext(ChatRuntimeContext);
  if (!runtime) {
    throw new Error("Chat runtime must be used within its provider.");
  }
  return runtime;
}

export function useOptionalChatRuntime(): ChatRuntime | undefined {
  return useContext(ChatRuntimeContext) ?? undefined;
}

export function useConversationRuntime(conversationId: string): ChatRuntimeSnapshot | undefined {
  const runtime = useChatRuntime();
  return useSyncExternalStore(
    runtime.subscribe,
    () => runtime.getSnapshot(conversationId),
    () => undefined,
  );
}

export function useOptionalConversationRuntime(
  conversationId: string | undefined,
): ChatRuntimeSnapshot | undefined {
  const runtime = useOptionalChatRuntime();
  return useSyncExternalStore(
    runtime?.subscribe ?? subscribeToNothing,
    runtime && conversationId ? () => runtime.getSnapshot(conversationId) : noRuntimeSnapshot,
    noRuntimeSnapshot,
  );
}
