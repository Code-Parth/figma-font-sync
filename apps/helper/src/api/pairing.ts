import { createHash, timingSafeEqual } from "node:crypto";
import type { Config, PairedClient, Store } from "../config/store";
import { HelperError } from "../errors";

const CODE_TTL_MS = 5 * 60_000;
const START_INTERVAL_MS = 10_000;
const MAX_ATTEMPTS = 5;
/** Wrong codes across every pending code. A new start replaces the code, so MAX_ATTEMPTS alone bounds nothing. */
const MAX_FAILURES = 20;
const LAST_USED_RESOLUTION_MS = 60_000;
const LOCKED_MESSAGE = "Too many wrong pairing codes. Restart the Font Sync helper to pair again.";

type PendingCode = { code: string; clientName: string; expiresAt: number; wrongAttempts: number };

/**
 * One pending 6-digit code at a time, valid 5 minutes; startPairing at most once per 10 s;
 * five wrong codes burn the pending code, and twenty since the last successful pairing lock pairing
 * until the helper restarts. Tokens are 32 random bytes, base64url; only their sha256 is stored in
 * config.pairedClients.
 */
export class Pairing {
  private pendingCode: PendingCode | null = null;
  private lastStartAt = Number.NEGATIVE_INFINITY;
  /** Wrong codes since the last successful pairing; start() does not reset it, and nothing remote can. */
  private failures = 0;
  /** When lastUsedAt was last written per client, so concurrent requests do not each write it. */
  private readonly lastUsedWrites = new Map<string, number>();

  constructor(
    private readonly config: Store<Config>,
    private readonly now: () => number = Date.now,
    /** Called once, when pairing locks, so the helper's log shows that something guessed codes. */
    private readonly onLocked: () => void = () => {},
  ) {}

  /** Throws HelperError "rate-limited" (too soon, or locked). */
  start(clientName: string): { code: string; expiresAt: Date } {
    if (this.locked()) throw new HelperError("rate-limited", LOCKED_MESSAGE);
    const now = this.now();
    if (now - this.lastStartAt < START_INTERVAL_MS) {
      throw new HelperError("rate-limited", "A pairing code was just created. Wait a few seconds and try again.");
    }
    this.lastStartAt = now;
    const pending = { code: randomCode(), clientName, expiresAt: now + CODE_TTL_MS, wrongAttempts: 0 };
    this.pendingCode = pending;
    return { code: pending.code, expiresAt: new Date(pending.expiresAt) };
  }

  /** The pending code for the local /pair page, or null. */
  pending(): { code: string; clientName: string; expiresAt: Date } | null {
    const pending = this.livePending();
    return pending && { code: pending.code, clientName: pending.clientName, expiresAt: new Date(pending.expiresAt) };
  }

  /** Throws HelperError "unauthorized" (wrong/expired) or "rate-limited" (code burned, or pairing locked). */
  async complete(code: string, clientName: string): Promise<{ token: string }> {
    if (this.locked()) throw new HelperError("rate-limited", LOCKED_MESSAGE);
    const pending = this.livePending();
    if (!pending) {
      throw new HelperError("unauthorized", "No pairing code is waiting, or it expired. Start pairing again.");
    }
    if (!sameString(code, pending.code)) {
      pending.wrongAttempts += 1;
      this.failures += 1;
      if (this.locked()) {
        this.pendingCode = null;
        this.onLocked();
        throw new HelperError("rate-limited", LOCKED_MESSAGE);
      }
      if (pending.wrongAttempts >= MAX_ATTEMPTS) {
        this.pendingCode = null;
        throw new HelperError("rate-limited", "Too many wrong codes. Start pairing again.");
      }
      throw new HelperError("unauthorized", "That code is not right. Check the code in your browser.");
    }
    // Cleared before the first await so a second request with the same code cannot also succeed.
    this.pendingCode = null;
    this.failures = 0;

    const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    const client: PairedClient = {
      id: crypto.randomUUID(),
      name: clientName,
      tokenHash: sha256Hex(token),
      createdAt: new Date(this.now()).toISOString(),
      lastUsedAt: null,
    };
    await this.config.update((draft) => {
      draft.pairedClients.push(client);
    });
    return { token };
  }

  /** Timing-safe check against stored hashes; updates lastUsedAt at most once a minute. */
  async verify(token: string): Promise<{ clientId: string } | null> {
    const presented = Buffer.from(sha256Hex(token), "hex");
    const { pairedClients } = await this.config.read();
    let match: PairedClient | null = null;
    // No early exit: every stored hash is compared so timing does not depend on the match position.
    for (const client of pairedClients) {
      const stored = Buffer.from(client.tokenHash, "hex");
      if (stored.length === presented.length && timingSafeEqual(stored, presented)) match = client;
    }
    if (!match) return null;

    const now = this.now();
    const storedLastUsed = match.lastUsedAt === null ? Number.NaN : Date.parse(match.lastUsedAt);
    const lastWrite = this.lastUsedWrites.get(match.id) ?? (Number.isFinite(storedLastUsed) ? storedLastUsed : null);
    if (lastWrite === null || now - lastWrite >= LAST_USED_RESOLUTION_MS) {
      this.lastUsedWrites.set(match.id, now);
      const id = match.id;
      // Bookkeeping only: a failed write must not turn a valid token into an error.
      await this.config
        .update((draft) => {
          const client = draft.pairedClients.find((c) => c.id === id);
          if (client) client.lastUsedAt = new Date(now).toISOString();
        })
        .catch(() => undefined);
    }
    return { clientId: match.id };
  }

  async revoke(clientId: string): Promise<void> {
    this.lastUsedWrites.delete(clientId);
    await this.config.update((draft) => {
      draft.pairedClients = draft.pairedClients.filter((c) => c.id !== clientId);
    });
  }

  async clients(): Promise<PairedClient[]> {
    return (await this.config.read()).pairedClients;
  }

  /** Returns how many clients were revoked. */
  async revokeAll(): Promise<number> {
    let count = 0;
    this.lastUsedWrites.clear();
    await this.config.update((draft) => {
      count = draft.pairedClients.length;
      draft.pairedClients = [];
    });
    return count;
  }

  private locked(): boolean {
    return this.failures >= MAX_FAILURES;
  }

  private livePending(): PendingCode | null {
    if (this.pendingCode && this.pendingCode.expiresAt <= this.now()) this.pendingCode = null;
    return this.pendingCode;
  }
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Uniform over 000000-999999: values past the last whole multiple of 10^6 are drawn again. */
function randomCode(): string {
  const limit = Math.floor(2 ** 32 / 1_000_000) * 1_000_000;
  const buffer = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buffer);
    const value = buffer[0] ?? limit;
    if (value < limit) return String(value % 1_000_000).padStart(6, "0");
  }
}

function sameString(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
