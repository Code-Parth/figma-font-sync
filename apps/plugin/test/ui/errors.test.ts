import { describe, expect, test } from "bun:test";
import { ApiError, asApiError, shouldRetry, toApiError, UNREACHABLE_MESSAGE } from "../../src/ui/errors";

describe("toApiError", () => {
  test("keeps code and message from the helper's error body", () => {
    const error = toApiError({ error: { code: "no-library", message: "Choose a library first." } }, 409, true);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(409);
    expect(error.code).toBe("no-library");
    expect(error.message).toBe("Choose a library first.");
    expect(error.authed).toBe(true);
  });

  test("drops an unknown code but keeps the message", () => {
    const error = toApiError({ error: { code: "brand-new", message: "Something new." } }, 400, false);
    expect(error.code).toBeNull();
    expect(error.message).toBe("Something new.");
  });

  test("does not treat Object.prototype names as known codes", () => {
    expect(toApiError({ error: { code: "toString", message: "x" } }, 400, false).code).toBeNull();
  });

  test("a fetch failure with no response is unreachable", () => {
    const error = toApiError(new TypeError("Failed to fetch"), 0, true);
    expect(error.status).toBe(0);
    expect(error.unreachable).toBe(true);
    expect(error.message).toBe(UNREACHABLE_MESSAGE);
  });

  test("shows a short plain-text body but never HTML", () => {
    expect(toApiError("Bad gateway", 502, false).message).toBe("Bad gateway");
    expect(toApiError("<html><body>nginx</body></html>", 502, false).message).toBe("The helper answered with HTTP 502.");
    expect(toApiError("x".repeat(500), 500, false).message).toBe("The helper answered with HTTP 500.");
    expect(toApiError({}, 500, false).message).toBe("The helper answered with HTTP 500.");
  });

  test("passes an ApiError through unchanged", () => {
    const original = new ApiError(401, "unauthorized", "No", true);
    expect(toApiError(original, 500, false)).toBe(original);
  });
});

describe("asApiError", () => {
  test("reads a raw error body as unreachable-free when it has a body", () => {
    expect(asApiError({ error: { code: "forbidden", message: "Nope" } }).code).toBe("forbidden");
  });

  test("treats anything unrecognised as unreachable", () => {
    expect(asApiError(undefined).unreachable).toBe(true);
    expect(asApiError(new TypeError("Failed to fetch")).unreachable).toBe(true);
  });

  test("names an aborted request as cancelled", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(asApiError(abort).message).toBe("The request was cancelled.");
  });
});

describe("shouldRetry", () => {
  test("never retries a 4xx", () => {
    for (const status of [400, 401, 403, 404, 409, 429]) {
      expect(shouldRetry(0, new ApiError(status, null, "x", true))).toBe(false);
    }
  });

  test("retries a 5xx or network failure once", () => {
    expect(shouldRetry(0, new ApiError(502, "google-error", "x", true))).toBe(true);
    expect(shouldRetry(1, new ApiError(502, "google-error", "x", true))).toBe(false);
    expect(shouldRetry(0, new ApiError(0, null, "x", true))).toBe(true);
    expect(shouldRetry(1, new ApiError(0, null, "x", true))).toBe(false);
  });
});
