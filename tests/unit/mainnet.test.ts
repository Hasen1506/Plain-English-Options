// Mainnet correctness against frames recorded read-only from Derive v3 mainnet
// (tests/fixtures/mainnet-public.json, `npm run record:mainnet`).
import { describe, expect, it } from "vitest";
import { NETWORKS } from "../../src/config.ts";
import { collateralFor, depositRoute, riskUniverseForOptions } from "../../src/net/onchain.ts";
import { maxFeePerUnit, quoteSpread, selectSpread, takerFee } from "../../src/lib/spread.ts";
import { isAligned, toE18 } from "../../src/lib/units.ts";
import { spotOf } from "../../src/lib/market.ts";
import { domainSeparatorFor, typedDataFor, digest, makeNonce } from "../../src/net/signing.ts";
import { ensureChain, type Eip1193 } from "../../src/net/signer.ts";
import { TypedDataEncoder } from "ethers";
import { MAINNET_AT, mainnetCurrencies, mainnetInstruments, mainnetPerp, mainnetRawCurrencies, mainnetTickers, mainnetUniverses } from "./mainnet-fixture.ts";

const net = NETWORKS.mainnet;

describe("mainnet risk universes (fetched, not assumed)", () => {
  it("ETH and BTC options live in universe 1 (PRIME), HYPE in 2, alts in 3", () => {
    expect(riskUniverseForOptions(mainnetUniverses, "ETH")).toBe(1);
    expect(riskUniverseForOptions(mainnetUniverses, "BTC")).toBe(1);
    expect(riskUniverseForOptions(mainnetUniverses, "HYPE")).toBe(2);
    for (const a of ["SOL", "ADA", "LIT", "CC"]) expect(riskUniverseForOptions(mainnetUniverses, a)).toBe(3);
    expect(mainnetUniverses.find((u) => u.id === 1)!.name).toBe("PRIME");
  });

  it("currency → universe from get_all_currencies is ambiguous for ETH (collateral everywhere), which is why the app maps from risk universes", () => {
    const eth = mainnetRawCurrencies.find((c) => c.currency === "ETH")!;
    const rus = (eth.managers as { risk_universe_id: number }[]).map((m) => m.risk_universe_id);
    expect(new Set(rus).size).toBeGreaterThan(1);
    expect(mainnetCurrencies.BTC!.riskUniverse).toBe(1);
  });

  it("a new ETH/BTC options subaccount: SM manager 1, Circle USDC (6 decimals), $5 minimum", () => {
    const r = depositRoute(mainnetUniverses, net, 1);
    expect(r.managerId).toBe(1);
    expect(r.collateral.erc20).toBe("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
    expect(r.collateral.assetAddress).toBe("0x57B03E14d409ADC7fAb6CFc44b5886CAD2D5f02b");
    expect(r.collateral.decimals).toBe(6);
    expect(r.collateral.minDepositUsd).toBe(5);
    expect(() => collateralFor(mainnetUniverses, NETWORKS.testnet, 1)).toThrow(/Unexpected USDC/);
  });

  it("ActionManager addresses match docs.derive.xyz/getting-started/contracts", () => {
    expect(NETWORKS.mainnet.actionManager).toBe("0xE366CcA474968e33b777E13905829A3b800CFAD3");
    expect(NETWORKS.testnet.actionManager).toBe("0xd3625eCf97E5554C62A48Ac1c9284C9dCeFceB68");
  });
});

describe("mainnet instruments: minimum, step, tick, fees", () => {
  it("every recorded mainnet option parses, with the published rules", () => {
    for (const cur of ["ETH", "BTC"]) {
      const { raw, parsed } = mainnetInstruments(cur);
      expect(parsed.length).toBe(raw.length);
      for (const i of parsed) {
        expect(i.baseFee).toBe(0.5);
        expect(i.takerFeeRate).toBe(0.0003);
        expect(i.markFeeCap).toBe(0.125);
      }
    }
    const eth = mainnetInstruments("ETH").parsed[0]!, btc = mainnetInstruments("BTC").parsed[0]!;
    expect([eth.tickSize, eth.minAmount, eth.amountStep]).toEqual(["0.1", "0.1", "0.01"]);
    expect([btc.tickSize, btc.minAmount, btc.amountStep]).toEqual(["1", "0.01", "0.00001"]);
  });

  it("every quotable mainnet spread is exchange-valid: size ≥ minimum and on the step, prices on the tick and inside the band, max fee covers the rule", () => {
    let checked = 0;
    for (const cur of ["ETH", "BTC"]) {
      const inst = mainnetInstruments(cur).parsed;
      for (const e of mainnetTickers(cur)) {
        const spot = spotOf(e.tickers).spot ?? mainnetPerp(cur)!.index;
        for (const dir of ["up", "down"] as const) {
          for (const mv of [0.01, 0.02, 0.04, 0.08]) {
            const sel = selectSpread(inst, e.tickers, spot, dir === "up" ? spot * (1 + mv) : spot * (1 - mv), dir, e.expiry, MAINNET_AT);
            if (!sel.ok) continue;
            for (const want of [1, 25, 100, 1000, 5000]) {
              const r = quoteSpread(sel.legs, want);
              if (!r.ok) continue;
              const q = r.quote, L = q.legs.long, S = q.legs.short;
              checked++;
              for (const leg of [L, S]) {
                expect(isAligned(q.amount, leg.instrument.amountStep)).toBe(true);
                expect(toE18(q.amount) >= toE18(leg.instrument.minAmount)).toBe(true);
              }
              expect(isAligned(q.longLimit, L.instrument.tickSize)).toBe(true);
              expect(isAligned(q.longPrice, L.instrument.tickSize)).toBe(true);
              if (Number(q.shortPrice) > 0) expect(isAligned(q.shortLimit, S.instrument.tickSize)).toBe(true);
              if (L.ticker.maxPrice !== null) expect(Number(q.longLimit)).toBeLessThanOrEqual(L.ticker.maxPrice + 1e-9);
              if (S.ticker.minPrice !== null && Number(q.shortPrice) > 0) expect(Number(q.shortLimit)).toBeGreaterThanOrEqual(S.ticker.minPrice - 1e-9);
              for (const [leg, px] of [[L, Number(q.longLimit)], [S, Number(q.shortLimit)]] as const) {
                const signed = Number(maxFeePerUnit(leg.instrument, leg.ticker.index, px, q.n));
                const rule = 2 * leg.instrument.takerFeeRate * Math.max(leg.ticker.index, px) + leg.instrument.baseFee / q.n;
                expect(signed).toBeGreaterThanOrEqual(rule);
                expect(signed * q.n).toBeGreaterThanOrEqual(takerFee(leg.instrument, leg.ticker.index, px, q.n) - 1e-9);
              }
              expect(q.worstLoss).toBeGreaterThanOrEqual(q.maxLoss - 1e-9);
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(20);
  });
});

describe("signing on mainnet (chain 1)", () => {
  it("domain separator and typed data for chain 1 hash to the published separator and our digest", () => {
    expect(domainSeparatorFor(1)).toBe(net.domainSeparator);
    const a = { subaccountId: 9, nonce: makeNonce(MAINNET_AT), module: net.tradeModule, data: "0x1234", expiry: Math.floor(MAINNET_AT / 1000) + 600, owner: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", signer: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" };
    const td = typedDataFor(a, net);
    expect(td.domain.chainId).toBe(1);
    const { EIP712Domain: _d, ...types } = td.types;
    expect(TypedDataEncoder.hash(td.domain, types, td.message)).toBe(digest(a, net));
  });

  it("asks the wallet to switch to chainId 0x1 before signing a mainnet action", async () => {
    let chain = "0xaa36a7";
    const asked: unknown[] = [];
    const p: Eip1193 = {
      request: async ({ method, params }) => {
        if (method === "eth_chainId") return chain;
        if (method === "wallet_switchEthereumChain") {
          asked.push(params);
          chain = (params as { chainId: string }[])[0]!.chainId;
          return null;
        }
        throw new Error(method);
      },
    };
    await ensureChain(p, 1);
    expect(asked).toEqual([[{ chainId: "0x1" }]]);
    await ensureChain(p, 1);
    expect(asked).toHaveLength(1);
  });
});
