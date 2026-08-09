import { Component, type ReactNode } from "react";
import type { ClientErrorReporter } from "./client-errors";
import { copy } from "./copy";

interface RootErrorBoundaryProps {
  readonly children: ReactNode;
  readonly reload?: (() => void) | undefined;
  readonly reporter: ClientErrorReporter;
}

interface RootErrorBoundaryState {
  readonly failed: boolean;
}

export class RootErrorBoundary extends Component<RootErrorBoundaryProps, RootErrorBoundaryState> {
  override state: RootErrorBoundaryState = { failed: false };
  private recoveryButton: HTMLButtonElement | null = null;

  static getDerivedStateFromError(): RootErrorBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(): void {
    try {
      this.props.reporter.report({ kind: "render" });
    } catch {
      // Reporting is best-effort and cannot replace the recovery UI with another failure.
    }
    this.recoveryButton?.focus();
  }

  override render(): ReactNode {
    if (!this.state.failed) {
      return this.props.children;
    }

    return (
      <main className="root-failure" id="main-content">
        <section aria-live="assertive" className="root-failure-panel">
          <p className="identity-eyebrow">{copy.rootFailure.eyebrow}</p>
          <h1>{copy.rootFailure.title}</h1>
          <p>{copy.rootFailure.description}</p>
          <button
            className="primary-button"
            onClick={() => (this.props.reload ?? (() => window.location.reload()))()}
            ref={(button) => {
              this.recoveryButton = button;
            }}
            type="button"
          >
            {copy.rootFailure.reload}
          </button>
        </section>
      </main>
    );
  }
}
