import capstoneSymbol from "@capstone/brand/assets/logos/capstone-icon.svg";
import type { GenerationModelTier } from "@capstone/protocol";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { copy } from "../copy";
import { DraftEditor } from "./draft-editor";
import { isModelTierAvailable, ModelTierPicker, useModelTierPolicy } from "./model-tiers";
import { useRouteHeading } from "./route-heading";

export function NewChatPage() {
  const navigate = useNavigate();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const policy = useModelTierPolicy();
  const [selectedTier, setSelectedTier] = useState<GenerationModelTier>();
  useRouteHeading(copy.conversations.newChat.documentTitle, headingRef, false);

  useEffect(() => {
    if (!selectedTier && policy.data) {
      setSelectedTier(policy.data.defaultTier);
    }
  }, [policy.data, selectedTier]);

  const tierAvailable = isModelTierAvailable(policy.data, selectedTier);

  return (
    <div className="new-chat-page">
      <div className="new-chat-intro">
        <img className="new-chat-symbol" src={capstoneSymbol} alt="" />
        <h1 ref={headingRef} tabIndex={-1}>
          {copy.conversations.newChat.title}
        </h1>
        <p>{copy.conversations.newChat.description}</p>
      </div>
      <DraftEditor
        scope={{ kind: "new" }}
        composer={{
          kind: "new",
          onConversationCreated: (conversationId) =>
            navigate(`/c/${conversationId}`, { state: { focusComposer: true } }),
        }}
        modelTier={selectedTier}
        tierAvailable={tierAvailable}
        tierControl={
          <ModelTierPicker
            error={policy.isError}
            id="new-chat"
            isPending={policy.isPending}
            onRetry={() => void policy.refetch()}
            onSelect={setSelectedTier}
            policy={policy.data}
            selectedTier={selectedTier}
          />
        }
        autoFocus
      />
    </div>
  );
}
