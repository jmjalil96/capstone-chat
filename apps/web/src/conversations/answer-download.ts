export interface DownloadEnvironment {
  readonly document: Document;
  readonly createObjectURL: (blob: Blob) => string;
  readonly revokeObjectURL: (url: string) => void;
  readonly scheduleCleanup: (callback: () => void) => void;
}

function browserDownloadEnvironment(): DownloadEnvironment {
  return {
    document: globalThis.document,
    createObjectURL: (blob) => globalThis.URL.createObjectURL(blob),
    revokeObjectURL: (url) => globalThis.URL.revokeObjectURL(url),
    scheduleCleanup: (callback) => globalThis.setTimeout(callback, 0),
  };
}

export function startTextDownload(
  contents: string,
  filename: string,
  mimeType: string,
  environment: DownloadEnvironment = browserDownloadEnvironment(),
): void {
  const blob = new Blob([contents], { type: mimeType });
  const url = environment.createObjectURL(blob);
  const anchor = environment.document.createElement("a");
  anchor.download = filename;
  anchor.href = url;
  anchor.hidden = true;
  environment.document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    environment.scheduleCleanup(() => environment.revokeObjectURL(url));
  }
}
