import { createHmac, timingSafeEqual } from "node:crypto";
import { ApplicationError } from "../errors.js";

const invalidCursorMessage = "El cursor de paginación no es válido.";

export type CursorPayload = Readonly<Record<string, unknown>> & {
  readonly kind: string;
  readonly version: 1;
};

function invalidCursor(): never {
  throw new ApplicationError(400, "INVALID_CURSOR", invalidCursorMessage);
}

export function createCursorCodec(secret: string) {
  function signature(encodedPayload: string): Buffer {
    return createHmac("sha256", secret).update(encodedPayload).digest();
  }

  function encode(payload: CursorPayload): string {
    const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    return `${encodedPayload}.${signature(encodedPayload).toString("base64url")}`;
  }

  function decode(cursor: string, kind: string): CursorPayload {
    const [encodedPayload, encodedSignature, extra] = cursor.split(".");
    if (
      encodedPayload === undefined ||
      encodedSignature === undefined ||
      extra !== undefined ||
      encodedPayload.length === 0 ||
      encodedSignature.length === 0
    ) {
      return invalidCursor();
    }

    let suppliedSignature: Buffer;
    let payload: unknown;
    try {
      suppliedSignature = Buffer.from(encodedSignature, "base64url");
      const expectedSignature = signature(encodedPayload);
      if (
        suppliedSignature.length !== expectedSignature.length ||
        !timingSafeEqual(suppliedSignature, expectedSignature)
      ) {
        return invalidCursor();
      }
      payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    } catch {
      return invalidCursor();
    }

    if (
      payload === null ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      (payload as Record<string, unknown>).version !== 1 ||
      (payload as Record<string, unknown>).kind !== kind
    ) {
      return invalidCursor();
    }
    return payload as CursorPayload;
  }

  return Object.freeze({ decode, encode });
}

export type CursorCodec = ReturnType<typeof createCursorCodec>;

export function cursorString(payload: CursorPayload, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    return invalidCursor();
  }
  return value;
}

export function cursorInteger(payload: CursorPayload, key: string): number {
  const value = payload[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return invalidCursor();
  }
  return value as number;
}

export function cursorBoolean(payload: CursorPayload, key: string): boolean {
  const value = payload[key];
  if (typeof value !== "boolean") {
    return invalidCursor();
  }
  return value;
}
