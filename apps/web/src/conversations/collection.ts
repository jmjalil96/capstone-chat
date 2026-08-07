import type {
  ConversationDetailResponse,
  ConversationMessage,
  ConversationSummary,
} from "@capstone/protocol";

export function uniqueConversations(
  pages: readonly { readonly conversations: readonly ConversationSummary[] }[],
): ConversationSummary[] {
  const seen = new Set<string>();
  const conversations: ConversationSummary[] = [];

  for (const page of pages) {
    for (const conversation of page.conversations) {
      if (!seen.has(conversation.id)) {
        seen.add(conversation.id);
        conversations.push(conversation);
      }
    }
  }

  return conversations;
}

export function orderedBranchMessages(
  pages: readonly ConversationDetailResponse[],
): ConversationMessage[] {
  const seen = new Set<string>();
  const messages: ConversationMessage[] = [];

  for (const page of [...pages].reverse()) {
    for (const message of page.messages) {
      if (!seen.has(message.id)) {
        seen.add(message.id);
        messages.push(message);
      }
    }
  }

  return messages;
}
