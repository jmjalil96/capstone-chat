import "@capstone/brand/styles.css";
import "./styles.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app";
import {
  createClientErrorReporter,
  deploymentRelease,
  installClientErrorListeners,
} from "./client-errors";
import { initializeIdentityCredentialFragment } from "./identity/credential-fragment";
import { RootErrorBoundary } from "./root-error-boundary";

initializeIdentityCredentialFragment();

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("The application root element is missing.");
}

const clientErrorReporter = createClientErrorReporter({ release: deploymentRelease() });
installClientErrorListeners(clientErrorReporter);

createRoot(rootElement).render(
  <StrictMode>
    <RootErrorBoundary reporter={clientErrorReporter}>
      <App />
    </RootErrorBoundary>
  </StrictMode>,
);
