import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { DeriveClient, DeriveRpcError, type WsCtor } from "../../src/net/client.ts";

/** Minimal fake socket; `server` decides how to answer each request. */
function fakeWs(server: (req: { id: number; method: string; params: Record<string, unknown> }, sock: FakeSock) => void) {
  const sockets: FakeSock[] = [];
  class FakeSock {
    readyState = 0;
    onopen: ((e: unknown) => void) | null = null;
    onclose: ((e: unknown) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    onmessage: ((e: { data: unknown }) => void) | null = null;
    sent: string[] = [];
    constructor(readonly url: string) {
      sockets.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        this.onopen?.({});
      });
    }
    send(d: string) {
      this.sent.push(d);
      server(JSON.parse(d), this);
    }
    reply(o: unknown) {
      queueMicrotask(() => this.onmessage?.({ data: typeof o === "string" ? o : JSON.stringify(o) }));
    }
    close() {
      this.readyState = 3;
      queueMicrotask(() => this.onclose?.({}));
    }
  }
  return { Ctor: FakeSock as unknown as WsCtor, sockets };
}
type FakeSock = { reply(o: unknown): void; close(): void; sent: string[] };

describe("DeriveClient", () => {
  it("matches responses to requests by id, whatever the order, and ignores junk frames", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.integer(), { minLength: 1, maxLength: 20 }), fc.array(fc.anything(), { maxLength: 5 }), async (vals, junk) => {
        const reqs: { id: number; v: unknown }[] = [];
        let sock: FakeSock | null = null;
        const { Ctor } = fakeWs((r, s) => {
          sock = s;
          reqs.push({ id: r.id, v: r.params.v });
          if (reqs.length === vals.length) {
            for (const j of junk) s.reply(typeof j === "string" ? j : JSON.stringify(j ?? null) ?? "null");
            s.reply("{not json");
            for (const q of [...reqs].reverse()) s.reply({ id: q.id, result: q.v });
          }
        });
        const c = new DeriveClient("ws://x", { WebSocketImpl: Ctor });
        c.connect();
        const out = await Promise.all(vals.map((v) => c.call("echo", { v })));
        expect(out).toEqual(vals);
        expect(sock).not.toBeNull();
        c.close();
      }),
      { numRuns: 200 },
    );
  });

  it("turns RPC errors into DeriveRpcError", async () => {
    const { Ctor } = fakeWs((r, s) => s.reply({ id: r.id, error: { code: -32602, message: "Invalid params", data: "Expiry date is required" } }));
    const c = new DeriveClient("ws://x", { WebSocketImpl: Ctor });
    c.connect();
    await expect(c.call("public/get_tickers", {})).rejects.toBeInstanceOf(DeriveRpcError);
    await expect(c.call("public/get_tickers", {})).rejects.toThrow("Invalid params: Expiry date is required");
    c.close();
  });

  it("times out a request that never gets an answer", async () => {
    vi.useFakeTimers();
    const { Ctor } = fakeWs(() => {});
    const c = new DeriveClient("ws://x", { WebSocketImpl: Ctor, timeoutMs: 500 });
    c.connect();
    const p = c.call("public/get_time");
    const exp = expect(p).rejects.toThrow("timeout");
    await vi.advanceTimersByTimeAsync(600);
    await exp;
    c.close();
    vi.useRealTimers();
  });

  it("reconnects with backoff, re-runs onOpen, and fails in-flight calls on close", async () => {
    vi.useFakeTimers();
    let opens = 0;
    const { Ctor, sockets } = fakeWs((r, s) => {
      if (r.method === "hang") return;
      s.reply({ id: r.id, result: "ok" });
    });
    const statuses: string[] = [];
    const c = new DeriveClient("ws://x", { WebSocketImpl: Ctor, backoffMs: 100, onOpen: () => void opens++, onStatus: (s) => statuses.push(s) });
    c.connect();
    await vi.advanceTimersByTimeAsync(1);
    const hanging = c.call("hang");
    const exp = expect(hanging).rejects.toThrow("connection closed");
    await vi.advanceTimersByTimeAsync(1);
    (sockets[0] as unknown as FakeSock).close();
    await exp;
    await vi.advanceTimersByTimeAsync(150);
    expect(sockets.length).toBe(2);
    expect(await c.call("x")).toBe("ok");
    expect(opens).toBe(2);
    expect(statuses).toEqual(["connecting", "open", "closed", "connecting", "open"]);
    c.close();
    vi.useRealTimers();
  });

  it("follows pagination in getAllInstruments", async () => {
    const pages: number[] = [];
    const { Ctor } = fakeWs((r, s) => {
      const page = r.params.page as number;
      pages.push(page);
      s.reply({ id: r.id, result: { instruments: [{ page }], pagination: { num_pages: 3, count: 3 } } });
    });
    const c = new DeriveClient("ws://x", { WebSocketImpl: Ctor });
    c.connect();
    expect(await c.getAllInstruments("ETH")).toEqual([{ page: 1 }, { page: 2 }, { page: 3 }]);
    expect(pages).toEqual([1, 2, 3]);
    c.close();
  });
});
