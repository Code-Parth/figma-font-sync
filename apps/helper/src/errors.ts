export const ERROR_CODES = [
  "bad-request",
  "unauthorized",
  "forbidden",
  "not-found",
  "conflict",
  "rate-limited",
  "not-configured",
  "not-signed-in",
  "no-library",
  "google-error",
  "install-failed",
  "internal",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** An error the API layer turns into `{ error: { code, message } }`; `message` is shown to the user. */
export class HelperError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HelperError";
  }
}
