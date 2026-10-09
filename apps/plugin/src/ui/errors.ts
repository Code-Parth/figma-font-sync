import type { Error as ErrorBody } from "./api/types.gen";

export type ErrorCode = ErrorBody["error"]["code"];

// A Record rather than an array so adding a code to the helper fails this file's typecheck.
const KNOWN_CODES: Record<ErrorCode, true> = {
  "bad-request": true,
  unauthorized: true,
  forbidden: true,
  "not-found": true,
  conflict: true,
  "rate-limited": true,
  "not-configured": true,
  "not-signed-in": true,
  "no-library": true,
  "google-error": true,
  "install-failed": true,
  internal: true,
};

/** Codes for helper state the gate screens handle: a 409 on any route means status is stale. */
export const STATE_CODES: ReadonlySet<ErrorCode> = new Set(["not-configured", "not-signed-in", "no-library"]);

export const UNREACHABLE_MESSAGE = "Can't reach the Font Sync helper.";

/**
 * Every failed helper call surfaces as this, so screens never inspect raw fetch errors.
 * `status` 0 means the helper did not answer: not running, or blocked before the request left.
 */
export class ApiError extends Error {
  override readonly name = "ApiError";

  constructor(
    readonly status: number,
    readonly code: ErrorCode | null,
    message: string,
    /** The request carried the pairing token, so a 401 means the pairing is gone. */
    readonly authed: boolean,
  ) {
    super(message);
  }

  get unreachable(): boolean {
    return this.status === 0;
  }
}

function isErrorBody(value: unknown): value is ErrorBody {
  if (typeof value !== "object" || value === null || !("error" in value)) return false;
  const inner = value.error;
  return (
    typeof inner === "object" &&
    inner !== null &&
    "code" in inner &&
    "message" in inner &&
    typeof inner.code === "string" &&
    typeof inner.message === "string"
  );
}

/**
 * Converts what the generated client throws (the parsed error body, a text body, or a fetch
 * TypeError) into an ApiError. `status` is 0 when no response arrived.
 */
export function toApiError(error: unknown, status: number, authed: boolean): ApiError {
  if (error instanceof ApiError) return error;
  if (isErrorBody(error)) {
    const code = Object.hasOwn(KNOWN_CODES, error.error.code) ? error.error.code : null;
    return new ApiError(status, code, error.error.message, authed);
  }
  if (status === 0) return new ApiError(0, null, UNREACHABLE_MESSAGE, authed);
  // Something else answered on the port, or a proxy did: never show its HTML.
  const text = typeof error === "string" ? error.trim() : "";
  const message = text && text.length <= 200 && !text.includes("<") ? text : `The helper answered with HTTP ${status}.`;
  return new ApiError(status, null, message, authed);
}

/** For display and retry decisions on errors whose declared type is the raw error body. */
export function asApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof Error && error.name === "AbortError") return new ApiError(0, null, "The request was cancelled.", false);
  return toApiError(error, 0, false);
}

/** TanStack Query retry policy: a 4xx will not change on retry; anything else gets one more try. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  const { status } = asApiError(error);
  if (status >= 400 && status < 500) return false;
  return failureCount < 1;
}
