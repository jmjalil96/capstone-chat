import type { ClientErrorKind, ClientErrorReport, ClientErrorRoute } from "@capstone/protocol";

const fingerprintedAssetPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*-[A-Za-z0-9_-]{6,}\.(?:css|js)$/u;
const releasePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const maximumPosition = 1_000_000;

export interface ClientErrorReporter {
  report(input: ClientErrorInput): void;
}

interface ClientErrorInput {
  readonly asset?: string | undefined;
  readonly column?: number | undefined;
  readonly kind: ClientErrorKind;
  readonly line?: number | undefined;
}

interface ClientErrorReporterOptions {
  readonly pathname?: (() => string) | undefined;
  readonly release: string;
  readonly send?: ((report: ClientErrorReport) => Promise<void> | void) | undefined;
}

function safePosition(value: number | undefined): number | undefined {
  return Number.isInteger(value) && value !== undefined && value >= 0 && value <= maximumPosition
    ? value
    : undefined;
}

export function clientErrorRoute(pathname: string): ClientErrorRoute {
  if (pathname === "/admin" || pathname.startsWith("/admin/")) {
    return "admin";
  }
  if (
    pathname === "/sign-in" ||
    pathname === "/sign-up" ||
    pathname === "/forgot-password" ||
    pathname === "/reset-password" ||
    pathname === "/verify-email"
  ) {
    return "identity";
  }
  if (
    pathname === "/" ||
    pathname === "/account" ||
    pathname === "/archived" ||
    pathname === "/search" ||
    pathname.startsWith("/c/")
  ) {
    return "chat";
  }
  return "unknown";
}

function browserSend(report: ClientErrorReport): void {
  const body = JSON.stringify(report);
  try {
    if (
      typeof navigator.sendBeacon === "function" &&
      navigator.sendBeacon("/api/client-errors", new Blob([body], { type: "application/json" }))
    ) {
      return;
    }
  } catch {
    // A blocked beacon falls through to the same-origin fetch transport.
  }

  try {
    void fetch("/api/client-errors", {
      body,
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      keepalive: true,
      method: "POST",
    }).catch(() => undefined);
  } catch {
    // Reporting failure is intentionally invisible to the employee.
  }
}

export function createClientErrorReporter(
  options: ClientErrorReporterOptions,
): ClientErrorReporter {
  const release = releasePattern.test(options.release) ? options.release : "unknown";
  const seen = new Set<string>();
  const pathname = options.pathname ?? (() => window.location.pathname);
  const send = options.send ?? browserSend;

  return Object.freeze({
    report(input: ClientErrorInput): void {
      const route = clientErrorRoute(pathname());
      const dedupeKey = `${release}:${route}:${input.kind}`;
      if (seen.has(dedupeKey)) {
        return;
      }
      seen.add(dedupeKey);

      const asset =
        input.asset !== undefined && fingerprintedAssetPattern.test(input.asset)
          ? input.asset
          : undefined;
      const line = safePosition(input.line);
      const column = safePosition(input.column);
      const report: ClientErrorReport = {
        kind: input.kind,
        release,
        route,
        ...(asset === undefined ? {} : { asset }),
        ...(line === undefined ? {} : { line }),
        ...(column === undefined ? {} : { column }),
      };

      try {
        void Promise.resolve(send(report)).catch(() => undefined);
      } catch {
        // Reporting failure is intentionally invisible to the employee.
      }
    },
  });
}

function applicationAsset(target: EventTarget | null, origin: string): string | undefined {
  let source: string | undefined;
  if (target instanceof HTMLScriptElement) {
    source = target.src;
  } else if (target instanceof HTMLLinkElement && target.rel === "stylesheet") {
    source = target.href;
  }
  if (source === undefined || source === "") {
    return undefined;
  }

  try {
    const url = new URL(source);
    if (url.origin !== origin || url.search !== "" || url.hash !== "") {
      return undefined;
    }
    const match = /^\/assets\/([^/]+)$/u.exec(url.pathname);
    const asset = match?.[1];
    return asset !== undefined && fingerprintedAssetPattern.test(asset) ? asset : undefined;
  } catch {
    return undefined;
  }
}

export function installClientErrorListeners(
  reporter: ClientErrorReporter,
  target: Window = window,
): () => void {
  const onError = (event: Event): void => {
    const asset = applicationAsset(event.target, target.location.origin);
    if (asset !== undefined) {
      reporter.report({ asset, kind: "resource" });
      return;
    }
    if (event instanceof ErrorEvent) {
      reporter.report({
        column: event.colno,
        kind: "unhandled_error",
        line: event.lineno,
      });
    }
  };
  const onUnhandledRejection = (): void => {
    reporter.report({ kind: "unhandled_rejection" });
  };

  target.addEventListener("error", onError, true);
  target.addEventListener("unhandledrejection", onUnhandledRejection);
  return () => {
    target.removeEventListener("error", onError, true);
    target.removeEventListener("unhandledrejection", onUnhandledRejection);
  };
}

export function deploymentRelease(): string {
  return import.meta.env.VITE_DEPLOYMENT_REVISION ?? "unknown";
}
