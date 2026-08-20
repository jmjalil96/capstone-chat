import type { SessionResponse } from "@capstone/protocol";
import { useQuery } from "@tanstack/react-query";
import { Link, useOutletContext } from "react-router";

import { copy } from "../copy";
import {
  assistantRulesQueryKeys,
  assistantRulesQueryScope,
  fetchMemberAssistantRules,
} from "./assistant-rules-api";
import { IdentityPanel } from "./identity-panel";

export function AssistantRulesPage() {
  const session = useOutletContext<SessionResponse>();
  const rules = useQuery({
    queryKey: assistantRulesQueryKeys.member(assistantRulesQueryScope(session)),
    queryFn: ({ signal }) => fetchMemberAssistantRules(signal),
  });

  return (
    <IdentityPanel
      eyebrow={copy.identity.assistantRules.eyebrow}
      title={copy.identity.assistantRules.title}
      description={copy.identity.assistantRules.description}
      wide
    >
      {rules.isPending ? (
        <p className="account-rules-status" role="status">
          {copy.identity.assistantRules.loading}
        </p>
      ) : rules.isError ? (
        <div className="form-message" data-kind="error" role="alert">
          <p>{copy.identity.assistantRules.error}</p>
          <button
            className="secondary-button compact-button"
            type="button"
            onClick={() => rules.refetch()}
          >
            {copy.identity.route.retry}
          </button>
        </div>
      ) : (
        <div className="account-rules">
          <p className="account-rules-readonly">{copy.identity.assistantRules.readOnly}</p>
          <p className="account-rules-updated">
            {copy.identity.assistantRules.updated}{" "}
            <time dateTime={rules.data.updatedAt}>
              {new Date(rules.data.updatedAt).toLocaleString("es-EC")}
            </time>
          </p>
          <section aria-labelledby="member-workspace-rules">
            <h2 id="member-workspace-rules">{copy.identity.assistantRules.workspaceTitle}</h2>
            <pre>{rules.data.workspaceText || copy.identity.assistantRules.emptyWorkspace}</pre>
          </section>
          <section aria-labelledby="member-locked-rules">
            <h2 id="member-locked-rules">{copy.identity.assistantRules.lockedTitle}</h2>
            <p className="field-help">
              {copy.identity.assistantRules.baseVersion(rules.data.baseVersion)}
            </p>
            <pre>{rules.data.baseText}</pre>
          </section>
          <section aria-labelledby="member-effective-rules">
            <h2 id="member-effective-rules">{copy.identity.assistantRules.effectiveTitle}</h2>
            <p className="field-help">{copy.identity.assistantRules.effectiveHelp}</p>
            <pre>{rules.data.effectivePrompt}</pre>
          </section>
        </div>
      )}
      <Link className="text-link" to="/">
        {copy.identity.common.backToHome}
      </Link>
    </IdentityPanel>
  );
}
