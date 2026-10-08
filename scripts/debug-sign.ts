// One-off: verify our EIP-712 signing against private/order_debug on testnet.
import { readFileSync } from "node:fs";
import { TypedDataEncoder } from "ethers";
import { NETWORKS } from "../src/config.ts";
import { DeriveClient } from "../src/net/client.ts";
import { keySigner } from "../src/net/signer.ts";
import { signOrder } from "../src/net/trader.ts";
import { parseInstruments } from "../src/lib/ticker.ts";
import { digest, typedDataFor, encodeTradeData, type ActionFields } from "../src/net/signing.ts";

const key = process.env.DERIVE_PRIVATE_KEY ?? readFileSync(process.env.KEY_FILE!, "utf8").trim();
const net = NETWORKS.testnet;
const signer = keySigner(key, net);
const c = new DeriveClient(net.wsUrl, {
  onOpen: async (cl) => {
    const ts = String(Date.now());
    await cl.callRaw("public/login", { wallet: signer.owner, timestamp: ts, signature: await signer.signLogin(ts) });
  },
});
c.connect();
const insts = parseInstruments({ instruments: await c.getAllInstruments("ETH") });
const inst = insts.find((i) => i.name === "ETH-20261016-2600-C")!;
let captured: ActionFields | null = null;
const spy = { ...signer, signAction: async (a: ActionFields) => { captured = a; return signer.signAction(a); } };
const o = await signOrder({ inst, direction: "buy", amount: "0.1", limitPrice: "1", maxFee: "5", tif: "gtc" }, { rpc: c, signer: spy, net, subaccountId: 87139 });
const dbg = await c.call<Record<string, unknown>>("private/order_debug", o);
const a = captured!;
const td = typedDataFor(a, net);
const { EIP712Domain: _d, ...types } = td.types;
console.log(JSON.stringify({
  action: a,
  ours: { digest: digest(a, net), typed: TypedDataEncoder.hash(td.domain, types, td.message), data: encodeTradeData({ assetAddress: inst.assetAddress, subId: inst.subId, limitPrice: "1", amount: "0.1", maxFee: "5", recipientId: 87139, isBid: true }) },
  theirs: { typed_data_hash: dbg.typed_data_hash, encoded_data: dbg.encoded_data, domain_separator: dbg.domain_separator, recovered_signer: dbg.recovered_signer, expected_signer: dbg.expected_signer },
}, null, 1));
c.close();
