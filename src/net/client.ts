// JSON-RPC over WebSocket to Derive v3: request ids, timeouts, reconnect with
// backoff, re-login hook, and paginated instrument loading. The WebSocket
// constructor is injectable so tests can drive it with a fake socket.

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export class DeriveRpcError extends Error {
  code: number;
  data: unknown;
  method: string;
  constructor(e: RpcError, method: string) {
    super(typeof e.data === "string" && e.data ? `${e.message}: ${e.data}` : e.message || "RPC error");
    this.method = method;
    this.code = e.code;
    this.data = e.data;
  }
}

export type Status = "connecting" | "open" | "closed";

interface WsLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}
export type WsCtor = new (url: string) => WsLike;

export interface ClientOptions {
  WebSocketImpl?: WsCtor;
  timeoutMs?: number;
  backoffMs?: number;
  maxBackoffMs?: number;
  onStatus?: (s: Status) => void;
  /** Runs after every (re)connect before queued calls resume, e.g. public/login. */
  onOpen?: (c: DeriveClient) => Promise<void> | void;
  setTimeoutFn?: typeof setTimeout;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
}

export class DeriveClient {
  private ws: WsLike | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private backoff: number;
  private closedByUser = false;
  private waiters: Array<() => void> = [];
  status: Status = "closed";
  readonly opts: Required<Omit<ClientOptions, "onOpen" | "onStatus">> & Pick<ClientOptions, "onOpen" | "onStatus">;

  readonly url: string;

  constructor(url: string, opts: ClientOptions = {}) {
    this.url = url;
    const WS = opts.WebSocketImpl ?? (globalThis.WebSocket as unknown as WsCtor);
    this.opts = {
      WebSocketImpl: WS,
      timeoutMs: opts.timeoutMs ?? 10_000,
      backoffMs: opts.backoffMs ?? 1_000,
      maxBackoffMs: opts.maxBackoffMs ?? 30_000,
      setTimeoutFn: opts.setTimeoutFn ?? (((f: () => void, ms?: number) => setTimeout(f, ms)) as typeof setTimeout), // unbound call would be an Illegal invocation in browsers
      onOpen: opts.onOpen,
      onStatus: opts.onStatus,
    };
    this.backoff = this.opts.backoffMs;
  }

  connect(): void {
    this.closedByUser = false;
    if (this.ws) return;
    this.setStatus("connecting");
    let ws: WsLike;
    try {
      ws = new this.opts.WebSocketImpl(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = async () => {
      if (this.ws !== ws) return;
      this.backoff = this.opts.backoffMs;
      try {
        await this.opts.onOpen?.(this);
      } catch {
        /* login failure surfaces through the caller's own state */
      }
      if (this.ws !== ws) return;
      this.setStatus("open");
      const w = this.waiters;
      this.waiters = [];
      w.forEach((f) => f());
    };
    ws.onmessage = (ev) => this.handle(ev.data);
    ws.onerror = () => {};
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.failAll(new Error("connection closed"));
      this.setStatus("closed");
      if (!this.closedByUser) this.scheduleReconnect();
    };
  }

  close(): void {
    this.closedByUser = true;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onclose = ws.onmessage = null;
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
    this.failAll(new Error("client closed"));
    this.setStatus("closed");
  }

  private setStatus(s: Status) {
    if (this.status === s) return;
    this.status = s;
    this.opts.onStatus?.(s);
  }

  private scheduleReconnect() {
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, this.opts.maxBackoffMs);
    this.opts.setTimeoutFn(() => {
      if (!this.closedByUser && !this.ws) this.connect();
    }, wait);
  }

  private failAll(e: Error) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
  }

  private handle(data: unknown) {
    let m: unknown;
    try {
      m = JSON.parse(typeof data === "string" ? data : String(data));
    } catch {
      return; // malformed frame: ignore
    }
    if (typeof m !== "object" || m === null) return;
    const msg = m as { id?: unknown; result?: unknown; error?: RpcError };
    if (typeof msg.id !== "number") return; // subscription or junk
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new DeriveRpcError(msg.error, p.method));
    else p.resolve(msg.result);
  }

  /** Wait until the socket is open (and onOpen finished). */
  ready(): Promise<void> {
    if (this.status === "open") return Promise.resolve();
    if (!this.ws) this.connect();
    return new Promise((r) => this.waiters.push(r));
  }

  /** Send now, even before onOpen has finished (used by onOpen itself for login). */
  callRaw<T = unknown>(method: string, params: object): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return Promise.reject(new Error("offline"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = this.opts.setTimeoutFn(() => {
        if (this.pending.delete(id)) reject(new Error(`timeout: ${method}`));
      }, this.opts.timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, method });
      try {
        ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  async call<T = unknown>(method: string, params: object = {}): Promise<T> {
    await this.ready();
    return this.callRaw<T>(method, params);
  }

  /** public/get_all_instruments, following pagination to the end. */
  async getAllInstruments(currency: string, pageSize = 1000): Promise<unknown[]> {
    const out: unknown[] = [];
    for (let page = 1; page <= 50; page++) {
      const r = await this.call<{ instruments?: unknown[]; pagination?: { num_pages?: number } }>("public/get_all_instruments", {
        currency,
        instrument_type: "option",
        expired: false,
        page,
        page_size: pageSize,
      });
      const list = Array.isArray(r?.instruments) ? r.instruments : [];
      out.push(...list);
      const pages = Number(r?.pagination?.num_pages ?? 1);
      if (!(page < pages) || !list.length) break;
    }
    return out;
  }
}
