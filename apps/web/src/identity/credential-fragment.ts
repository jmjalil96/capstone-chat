export type IdentityCredentialPath = "/reset-password" | "/verify-email";

export interface IdentityCredential {
  readonly invalid: boolean;
  readonly token: string | null;
}

interface CapturedCredential extends IdentityCredential {
  readonly path: IdentityCredentialPath;
}

const maximumCredentialCharacters = 4_096;
let capturedCredential: CapturedCredential | undefined;

function identityPath(pathname: string): IdentityCredentialPath | undefined {
  if (pathname === "/reset-password" || pathname === "/verify-email") {
    return pathname;
  }
  return undefined;
}

export function initializeIdentityCredentialFragment(): void {
  const path = identityPath(window.location.pathname);
  if (path === undefined || window.location.hash.length === 0) {
    return;
  }

  const parameters = new URLSearchParams(window.location.hash.slice(1));
  const tokens = parameters.getAll("token");
  const token =
    [...parameters.keys()].every((key) => key === "token") &&
    tokens.length === 1 &&
    tokens[0] !== undefined &&
    tokens[0].length > 0 &&
    tokens[0].length <= maximumCredentialCharacters
      ? tokens[0]
      : null;
  capturedCredential = Object.freeze({ invalid: token === null, path, token });

  const visibleUrl = new URL(window.location.href);
  visibleUrl.hash = "";
  visibleUrl.searchParams.delete("token");
  window.history.replaceState(
    window.history.state,
    "",
    `${visibleUrl.pathname}${visibleUrl.search}`,
  );
}

export function readIdentityCredential(path: IdentityCredentialPath): IdentityCredential {
  initializeIdentityCredentialFragment();
  if (capturedCredential?.path === path) {
    return capturedCredential;
  }
  return Object.freeze({ invalid: false, token: null });
}

export function clearIdentityCredential(path: IdentityCredentialPath): void {
  if (capturedCredential?.path === path) {
    capturedCredential = undefined;
  }
}
