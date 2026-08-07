import { useRef } from "react";

import { copy } from "../copy";
import { ConversationHistory } from "./conversation-history";
import { useRouteHeading } from "./route-heading";

export function ArchivedPage() {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useRouteHeading(copy.conversations.archived.documentTitle, headingRef);

  return (
    <div className="collection-page archived-page">
      <header className="collection-header">
        <h1 ref={headingRef} tabIndex={-1}>
          {copy.conversations.archived.title}
        </h1>
        <p>{copy.conversations.archived.description}</p>
      </header>
      <ConversationHistory view="archived" />
    </div>
  );
}
