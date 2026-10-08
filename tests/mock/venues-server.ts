// HTTP mock for the venues with REST APIs (e2e only), CORS open like the real ones:
//   POST /hl/<net>/<sid>/info | /exchange      Hyperliquid (tests/mock/hyperliquid.ts)
//   POST /hl/<net>/<sid>/mock/credit           side channel: a CCTP deposit landing {user, usdc}
//   GET  /hl/<net>/<sid>/mock/state            side channel: the mock's state (agents, log, withdrawals)
//   POST /vr/<net>/<sid>/<method>               Veranta (tests/mock/veranta.ts), GET …/mock/state
// State is per (venue, net, sid), so parallel Playwright tests never share an account.
//
//   node --experimental-strip-types tests/mock/venues-server.ts [port]

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { hlCredit, hlExchange, hlInfo, newHlState, HL_RECORDED_AT, type HlMockState, type Net } from "./hyperliquid.ts";
import { TEST_ADDRESS, TEST_START_USDC } from "./venue-constants.ts";
import { verantaRoute } from "./veranta.ts";

type Extra = (path: string[], body: unknown, method: string) => Promise<unknown> | unknown;
const extras: Record<string, Extra> = { vr: verantaRoute };
export function registerVenue(prefix: string, f: Extra) {
  extras[prefix] = f;
}

const hl = new Map<string, HlMockState>();
function hlState(net: Net, sid: string): HlMockState {
  const k = `${net}|${sid}`;
  let st = hl.get(k);
  if (!st) {
    st = newHlState(net, () => HL_RECORDED_AT + 60_000 + (Date.now() - started));
    // scenario from the sid prefix: "hlempty-…" = no Hyperliquid account yet (deposit first)
    // "hlnomain-…" = no account anywhere, not even on mainnet (testnet deposits must be refused)
    if (sid.startsWith("hlnomain")) st.noMainnet = true;
    else if (!sid.startsWith("hlempty")) hlCredit(st, TEST_ADDRESS, TEST_START_USDC);
    hl.set(k, st);
  }
  return st;
}
const started = Date.now();

function send(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS" });
  res.end(JSON.stringify(body));
}
const readBody = (req: IncomingMessage) =>
  new Promise<unknown>((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      try {
        resolve(b ? JSON.parse(b) : null);
      } catch {
        resolve(null);
      }
    });
  });

export function startVenues(port: number) {
  const srv = createServer(async (req, res) => {
    if (req.method === "OPTIONS") return send(res, 204, null);
    const url = new URL(req.url ?? "/", "http://x");
    const parts = url.pathname.split("/").filter(Boolean);
    const body = await readBody(req);
    try {
      if (parts[0] === "hl") {
        const [, net, sid, ...rest] = parts as [string, Net, string, ...string[]];
        const st = hlState(net, sid);
        const path = rest.join("/");
        if (path === "info") return send(res, 200, hlInfo(st, body as Record<string, unknown>));
        if (path === "exchange") return send(res, 200, hlExchange(st, body as never));
        if (path === "mock/credit") {
          const b = body as { user: string; usdc: number };
          hlCredit(st, b.user, b.usdc);
          return send(res, 200, { ok: true });
        }
        if (path === "mock/state") return send(res, 200, { agents: [...st.agents.entries()], log: st.log, withdrawals: st.withdrawals, balance: st.balance, pos: st.pos, lev: st.lev });
        return send(res, 404, { error: "no route" });
      }
      const ex = extras[parts[0] ?? ""];
      if (ex) return send(res, 200, await ex(parts.slice(1), body, req.method ?? "GET"));
      send(res, 404, { error: "no route" });
    } catch (e) {
      send(res, 500, { error: (e as Error).message });
    }
  });
  srv.listen(port, "127.0.0.1");
  return srv;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] ?? 8788);
  startVenues(port);
  console.log(`mock venues http on http://127.0.0.1:${port}`);
}
