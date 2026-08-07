import { useCallback, useEffect, useRef, useState } from "react";

export function useFeedbackAttempt(): readonly [number, () => void] {
  const [attempt, setAttempt] = useState(0);
  const beginAttempt = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  return [attempt, beginAttempt] as const;
}

export function FieldError({ id, message }: { id: string; message: string | undefined }) {
  if (!message) {
    return null;
  }

  return (
    <p className="field-error" id={id}>
      {message}
    </p>
  );
}

export function FormMessage({
  focusKey,
  kind,
  message,
}: {
  focusKey?: number;
  kind: "error" | "success";
  message: string | undefined;
}) {
  const messageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (message && (focusKey === undefined || focusKey >= 0)) {
      messageRef.current?.focus();
    }
  }, [focusKey, message]);

  if (!message) {
    return null;
  }

  return (
    <div
      className="form-message"
      data-kind={kind}
      ref={messageRef}
      role={kind === "error" ? "alert" : "status"}
      tabIndex={-1}
    >
      {message}
    </div>
  );
}
