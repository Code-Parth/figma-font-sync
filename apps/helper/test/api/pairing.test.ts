import { describe, expect, it, spyOn } from "bun:test";
import { Pairing, sha256Hex } from "../../src/api/pairing";
import { HelperError } from "../../src/errors";
import { emptyConfig, manualClock, MemoryStore } from "./support";

function setup() {
  const clock = manualClock();
  const config = new MemoryStore(emptyConfig());
  return { clock, config, pairing: new Pairing(config, clock.now) };
}

async function rejection(promise: Promise<unknown>): Promise<HelperError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof HelperError) return err;
    throw err;
  }
  throw new Error("expected a HelperError");
}

describe("Pairing", () => {
  it("creates a 6-digit code that expires in 5 minutes", () => {
    const { pairing, clock } = setup();
    const { code, expiresAt } = pairing.start("Figma");
    expect(code).toMatch(/^\d{6}$/);
    expect(expiresAt.getTime()).toBe(clock.now() + 5 * 60_000);
    expect(pairing.pending()).toEqual({ code, clientName: "Figma", expiresAt });
  });

  it("keeps leading zeros in the code", () => {
    const spy = spyOn(crypto, "getRandomValues").mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
      if (array instanceof Uint32Array) array[0] = 42;
      return array;
    });
    try {
      const { pairing } = setup();
      expect(pairing.start("Figma").code).toBe("000042");
    } finally {
      spy.mockRestore();
    }
  });

  it("allows one start every 10 seconds", () => {
    const { pairing, clock } = setup();
    pairing.start("Figma");
    clock.advance(9_999);
    expect(() => pairing.start("Figma")).toThrow(HelperError);
    clock.advance(1);
    expect(() => pairing.start("Figma")).not.toThrow();
  });

  it("forgets the code after 5 minutes", async () => {
    const { pairing, clock } = setup();
    const { code } = pairing.start("Figma");
    clock.advance(5 * 60_000);
    expect(pairing.pending()).toBeNull();
    expect((await rejection(pairing.complete(code, "Figma"))).code).toBe("unauthorized");
  });

  it("burns the code on the fifth wrong attempt", async () => {
    const { pairing } = setup();
    const { code } = pairing.start("Figma");
    const wrong = code === "111111" ? "222222" : "111111";
    for (let i = 0; i < 4; i++) expect((await rejection(pairing.complete(wrong, "Figma"))).code).toBe("unauthorized");
    expect((await rejection(pairing.complete(wrong, "Figma"))).code).toBe("rate-limited");
    expect(pairing.pending()).toBeNull();
    expect((await rejection(pairing.complete(code, "Figma"))).code).toBe("unauthorized");
  });

  it("locks pairing after 20 wrong codes, even when every code is replaced before it burns", async () => {
    const { config, clock } = setup();
    let lockouts = 0;
    const pairing = new Pairing(config, clock.now, () => {
      lockouts += 1;
    });
    // Four guesses per code, then a new start: no code ever reaches MAX_ATTEMPTS.
    for (let round = 0; round < 5; round++) {
      const { code } = pairing.start("Figma");
      const wrong = code === "111111" ? "222222" : "111111";
      for (let i = 0; i < 3; i++) expect((await rejection(pairing.complete(wrong, "Figma"))).code).toBe("unauthorized");
      const fourth = await rejection(pairing.complete(wrong, "Figma"));
      expect(fourth.code).toBe(round < 4 ? "unauthorized" : "rate-limited");
      clock.advance(10_000);
    }
    expect(lockouts).toBe(1);
    expect(pairing.pending()).toBeNull();

    expect(() => pairing.start("Figma")).toThrow("Restart the Font Sync helper");
    clock.advance(60 * 60_000);
    expect(() => pairing.start("Figma")).toThrow("Restart the Font Sync helper");
    expect((await rejection(pairing.complete("123456", "Figma"))).code).toBe("rate-limited");
    expect(lockouts).toBe(1);
  });

  it("forgets wrong codes after a successful pairing", async () => {
    const { pairing, clock } = setup();
    const guessWrong = async (times: number) => {
      const { code } = pairing.start("Figma");
      const wrong = code === "111111" ? "222222" : "111111";
      for (let i = 0; i < times; i++) await rejection(pairing.complete(wrong, "Figma"));
      clock.advance(10_000);
    };
    for (let round = 0; round < 4; round++) await guessWrong(4);
    await guessWrong(3);
    await pairing.complete(pairing.start("Figma").code, "Figma");
    clock.advance(10_000);
    for (let round = 0; round < 4; round++) await guessWrong(4);
    expect(() => pairing.start("Figma")).not.toThrow();
  });

  it("stores only the sha256 of the token and accepts the token afterwards", async () => {
    const { pairing, config } = setup();
    const { code } = pairing.start("Figma");
    const { token } = await pairing.complete(code, "Figma desktop");
    expect(Buffer.from(token, "base64url")).toHaveLength(32);

    const stored = await config.read();
    expect(stored.pairedClients).toHaveLength(1);
    expect(stored.pairedClients[0]?.name).toBe("Figma desktop");
    expect(stored.pairedClients[0]?.tokenHash).toBe(sha256Hex(token));
    expect(JSON.stringify(stored)).not.toContain(token);

    expect(await pairing.verify(token)).toEqual({ clientId: stored.pairedClients[0]?.id ?? "" });
    expect(await pairing.verify(`${token}x`)).toBeNull();
    expect(await pairing.verify("")).toBeNull();
  });

  it("uses a code only once", async () => {
    const { pairing } = setup();
    const { code } = pairing.start("Figma");
    const [first, second] = await Promise.allSettled([pairing.complete(code, "A"), pairing.complete(code, "B")]);
    expect(first.status).toBe("fulfilled");
    expect(second.status).toBe("rejected");
  });

  it("writes lastUsedAt at most once a minute", async () => {
    const { pairing, config, clock } = setup();
    const { code } = pairing.start("Figma");
    const { token } = await pairing.complete(code, "Figma");
    const writesAfterPairing = config.writes;

    await pairing.verify(token);
    expect(config.writes).toBe(writesAfterPairing + 1);
    expect((await config.read()).pairedClients[0]?.lastUsedAt).toBe(new Date(clock.now()).toISOString());

    clock.advance(59_000);
    await pairing.verify(token);
    await pairing.verify(token);
    expect(config.writes).toBe(writesAfterPairing + 1);

    clock.advance(1_000);
    await pairing.verify(token);
    expect(config.writes).toBe(writesAfterPairing + 2);
  });

  it("revokes one client, then all", async () => {
    const { pairing, clock } = setup();
    const first = await pairing.complete(pairing.start("A").code, "A");
    clock.advance(10_000);
    const second = await pairing.complete(pairing.start("B").code, "B");

    const verified = await pairing.verify(first.token);
    if (!verified) throw new Error("first token should verify");
    await pairing.revoke(verified.clientId);
    expect(await pairing.verify(first.token)).toBeNull();
    expect(await pairing.verify(second.token)).not.toBeNull();

    expect(await pairing.revokeAll()).toBe(1);
    expect(await pairing.verify(second.token)).toBeNull();
    expect(await pairing.clients()).toEqual([]);
  });
});
