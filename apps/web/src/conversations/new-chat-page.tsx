import capstoneSymbol from "@capstone/brand/assets/logos/capstone-icon.svg";
import { useRef } from "react";
import { useNavigate } from "react-router";

import { copy } from "../copy";
import { DraftEditor } from "./draft-editor";
import { useRouteHeading } from "./route-heading";

export function NewChatPage() {
  const navigate = useNavigate();
  const headingRef = useRef<HTMLHeadingElement>(null);
  useRouteHeading(copy.conversations.newChat.documentTitle, headingRef, false);

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
        autoFocus
      />
    </div>
  );
}
