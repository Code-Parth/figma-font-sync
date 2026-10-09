import type { SecretStore } from "../../src/config/secrets";

export type FakeRequest = { method: string; url: URL; headers: Headers; body: Uint8Array };
export type Handler = (request: FakeRequest) => Response | Promise<Response>;

/**
 * A fetch that answers from `routes` and never touches the network. Keys are "METHOD /path" with an
 * optional query ("GET /drive/v3/files?pageToken=p2"); a key matches when every listed parameter is
 * equal, and the most specific match wins. An array answers in turn and then repeats its last entry.
 * Unmatched requests throw, so a missing route fails the test.
 */
export function fakeFetch(routes: Record<string, Handler | Handler[]>) {
  const requests: FakeRequest[] = [];
  const served = new Map<string, number>();
  const parsed = Object.entries(routes).map(([key, handler]) => {
    const [method = "", target = ""] = key.split(" ");
    const url = new URL(target, "http://route.test");
    return { key, method, path: url.pathname, query: [...url.searchParams], handler };
  });

  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
    const url = new URL(request.url);
    const recorded: FakeRequest = {
      method: request.method,
      url,
      headers: request.headers,
      body: new Uint8Array(await request.arrayBuffer()),
    };
    requests.push(recorded);
    const route = parsed
      .filter(
        (r) =>
          r.method === request.method &&
          r.path === url.pathname &&
          r.query.every(([name, value]) => url.searchParams.get(name) === value),
      )
      .sort((a, b) => b.query.length - a.query.length)[0];
    if (!route) throw new Error(`fakeFetch: no route for ${request.method} ${url}`);
    const count = served.get(route.key) ?? 0;
    served.set(route.key, count + 1);
    const handler = Array.isArray(route.handler)
      ? route.handler[Math.min(count, route.handler.length - 1)]
      : route.handler;
    if (!handler) throw new Error(`fakeFetch: empty handler list for ${route.key}`);
    return handler(recorded);
  };

  return { fetch: Object.assign(impl, { preconnect: fetch.preconnect }), requests };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export function googleError(status: number, reason: string, message: string): Response {
  return json({ error: { code: status, message, errors: [{ reason, message, domain: "global" }] } }, status);
}

export function form(request: FakeRequest): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(new TextDecoder().decode(request.body)));
}

export class MemorySecrets implements SecretStore {
  readonly values = new Map<string, string>();

  async get(name: string): Promise<string | null> {
    return this.values.get(name) ?? null;
  }

  async set(name: string, value: string): Promise<void> {
    this.values.set(name, value);
  }

  async delete(name: string): Promise<void> {
    this.values.delete(name);
  }
}
