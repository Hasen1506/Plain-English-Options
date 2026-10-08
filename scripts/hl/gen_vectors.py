# Generates tests/fixtures/hyperliquid/sign-vectors.json with the OFFICIAL
# hyperliquid-python-sdk (pip install hyperliquid-python-sdk==0.24.0).
# Part 1 copies the SDK's own known-answer tests (tests/signing_test.py).
# Part 2 signs a deterministic set of actions shaped like the ones this app
# sends (orders incl. triggers/ALO/reduce-only, cancels, updateLeverage,
# approveAgent, withdraw3) with the SDK's code, so the TS port is checked
# against the reference implementation, not against itself.
import json, random
import eth_account
from eth_utils import to_hex
from hyperliquid.utils.signing import (action_hash, sign_l1_action, sign_agent, sign_withdraw_from_bridge_action,
    sign_usd_transfer_action, float_to_int_for_hashing, order_request_to_order_wire, order_wires_to_order_action)
from hyperliquid.utils.types import Cloid
import hyperliquid
KEY = "0x0123456789012345678901234567890123456789012345678901234567890123"  # the SDK tests' public test key
w = eth_account.Account.from_key(KEY)
out = {"source": "hyperliquid-python-sdk " + "0.24.0", "key": KEY, "address": w.address, "official": [], "generated": []}

def sig(s): return {"r": to_hex(s["r"]) if isinstance(s["r"], int) else s["r"], "s": s["s"], "v": s["v"]}
def l1(name, action, vault, nonce, exp, main, expect=None):
    s = sign_l1_action(w, action, vault, nonce, exp, main)
    v = {"name": name, "kind": "l1", "action": action, "vault": vault, "nonce": nonce, "expiresAfter": exp, "mainnet": main,
         "connectionId": to_hex(action_hash(action, vault, nonce, exp)), "sig": s}
    if expect: assert int(s["r"],16) == int(expect["r"],16) and s["v"] == expect["v"], name
    return v

# ---- part 1: official SDK test vectors (expected values copied from tests/signing_test.py) ----
o = lambda coin, b, sz, px, ot, cl=None, a=1: order_wires_to_order_action([order_request_to_order_wire({"coin":coin,"is_buy":b,"sz":sz,"limit_px":px,"reduce_only":False,"order_type":ot,"cloid":cl}, a)])
dummy = {"type": "dummy", "num": float_to_int_for_hashing(1000)}
O = out["official"]
O.append(l1("dummy mainnet", dummy, None, 0, None, True, {"r":"0x53749d5b30552aeb2fca34b530185976545bb22d0b3ce6f62e31be961a59298","v":27}))
O.append(l1("dummy testnet", dummy, None, 0, None, False, {"r":"0x542af61ef1f429707e3c76c5293c80d01f74ef853e34b76efffcb57e574f9510","v":28}))
gtc = o("ETH", True, 100, 100, {"limit": {"tif": "Gtc"}})
O.append(l1("order mainnet", gtc, None, 0, None, True, {"r":"0xd65369825a9df5d80099e513cce430311d7d26ddf477f5b3a33d2806b100d78e","v":28}))
O.append(l1("order testnet", gtc, None, 0, None, False, {"r":"0x82b2ba28e76b3d761093aaded1b1cdad4960b3af30212b343fb2e6cdfa4e3d54","v":27}))
cl = o("ETH", True, 100, 100, {"limit": {"tif": "Gtc"}}, Cloid.from_str("0x00000000000000000000000000000001"))
O.append(l1("order cloid mainnet", cl, None, 0, None, True, {"r":"0x41ae18e8239a56cacbc5dad94d45d0b747e5da11ad564077fcac71277a946e3","v":27}))
O.append(l1("order cloid testnet", cl, None, 0, None, False, {"r":"0xeba0664bed2676fc4e5a743bf89e5c7501aa6d870bdb9446e122c9466c5cd16d","v":28}))
V = "0x1719884eb866cb12b2287399b15f7db5e7d775ea"
O.append(l1("dummy vault mainnet", dummy, V, 0, None, True, {"r":"0x3c548db75e479f8012acf3000ca3a6b05606bc2ec0c29c50c515066a326239","v":28}))
O.append(l1("dummy vault testnet", dummy, V, 0, None, False, {"r":"0xe281d2fb5c6e25ca01601f878e4d69c965bb598b88fac58e475dd1f5e56c362b","v":27}))
tpsl = o("ETH", True, 100, 100, {"trigger": {"triggerPx": 103, "isMarket": True, "tpsl": "sl"}})
O.append(l1("tpsl mainnet", tpsl, None, 0, None, True, {"r":"0x98343f2b5ae8e26bb2587daad3863bc70d8792b09af1841b6fdd530a2065a3f9","v":27}))
O.append(l1("tpsl testnet", tpsl, None, 0, None, False, {"r":"0x971c554d917c44e0e1b6cc45d8f9404f32172a9d3b3566262347d0302896a2e4","v":28}))
O.append(l1("scheduleCancel mainnet", {"type": "scheduleCancel"}, None, 0, None, True, {"r":"0x6cdfb286702f5917e76cd9b3b8bf678fcc49aec194c02a73e6d4f16891195df9","v":27}))
O.append(l1("scheduleCancel time testnet", {"type": "scheduleCancel", "time": 123456789}, None, 0, None, False, {"r":"0x4e4f2dbd4107c69783e251b7e1057d9f2b9d11cee213441ccfa2be63516dc5bc","v":27}))
sp = {"type": "subAccountTransfer", "subAccountUser": "0x1d9470d4b963f552e6f671a81619d395877bf409", "isDeposit": True, "usd": 10}
O.append(l1("subAccountTransfer mainnet", sp, None, 0, None, True, {"r":"0x43592d7c6c7d816ece2e206f174be61249d651944932b13343f4d13f306ae602","v":28}))
msg = {"destination": "0x5e9ee1089755c3435139848e47e6635505d5a13a", "amount": "1", "time": 1687816341423}
m1 = dict(msg); s = sign_withdraw_from_bridge_action(w, m1, False)
assert int(s["r"],16) == int("0x8363524c799e90ce9bc41022f7c39b4e9bdba786e5f9c72b20e43e1462c37cf9",16)
O.append({"name": "withdraw3 testnet", "kind": "user", "primaryType": "HyperliquidTransaction:Withdraw", "action": {**m1, "type": "withdraw3"}, "sig": s})
m2 = dict(msg); s = sign_usd_transfer_action(w, m2, False)
assert int(s["r"],16) == int("0x637b37dd731507cdd24f46532ca8ba6eec616952c56218baeff04144e4a77073",16)
O.append({"name": "usdSend testnet", "kind": "user", "primaryType": "HyperliquidTransaction:UsdSend", "action": {**m2, "type": "usdSend"}, "sig": s})

# ---- part 2: generated with the SDK, shaped like the app's own actions ----
rnd = random.Random(20261008)
G = out["generated"]
coins = [("BTC", 0, 5), ("ETH", 1, 4), ("SOL", 5, 2), ("DOGE", 12, 0), ("kPEPE", 98, 0)]
for i in range(40):
    coin, a, szd = rnd.choice(coins)
    main = rnd.random() < 0.5
    sz = round(rnd.uniform(0.001, 50), szd) or 1
    px = float(f"{rnd.uniform(0.0001, 120000):.5g}")
    kind = rnd.choice(["Gtc", "Ioc", "Alo", "tp", "sl"])
    ot = {"limit": {"tif": kind}} if kind in ("Gtc", "Ioc", "Alo") else {"trigger": {"triggerPx": float(f"{px*1.01:.5g}"), "isMarket": True, "tpsl": kind}}
    req = {"coin": coin, "is_buy": rnd.random() < 0.5, "sz": sz, "limit_px": px, "reduce_only": kind in ("tp","sl") or rnd.random() < 0.3, "order_type": ot, "cloid": None}
    wires = [order_request_to_order_wire(req, a)]
    grouping = "na"
    if kind in ("tp", "sl") and rnd.random() < 0.5:
        entry = {**req, "reduce_only": False, "order_type": {"limit": {"tif": "Ioc"}}}
        wires = [order_request_to_order_wire(entry, a)] + wires
        grouping = "normalTpsl"
    act = order_wires_to_order_action(wires, None, grouping)
    nonce = 1760000000000 + i * 7919
    exp = nonce + 60000 if rnd.random() < 0.25 else None
    G.append(l1(f"order {i} {coin} {kind}", act, None, nonce, exp, main))
for i in range(6):
    act = {"type": "cancel", "cancels": [{"a": rnd.choice(coins)[1], "o": rnd.randint(1, 2**40)} for _ in range(rnd.randint(1, 3))]}
    G.append(l1(f"cancel {i}", act, None, 1760000100000 + i, None, i % 2 == 0))
for i in range(6):
    act = {"type": "updateLeverage", "asset": rnd.choice(coins)[1], "isCross": i % 2 == 0, "leverage": rnd.randint(1, 40)}
    G.append(l1(f"updateLeverage {i}", act, None, 1760000200000 + i, None, i % 2 == 1))
for i in range(4):
    nonce = 1760000300000 + i
    agent = eth_account.Account.from_key("0x" + format(i + 7, "064x")).address
    act = {"type": "approveAgent", "agentAddress": agent, "agentName": f"peo valid_until {nonce + 86400000}" if i % 2 == 0 else "", "nonce": nonce}
    s = sign_agent(w, act, i < 2)
    G.append({"name": f"approveAgent {i}", "kind": "user", "primaryType": "HyperliquidTransaction:ApproveAgent", "action": act, "sig": s})
for i in range(3):
    t = 1760000400000 + i
    act = {"destination": w.address, "amount": str([5, 12.5, 1000][i]), "time": t, "type": "withdraw3"}
    s = sign_withdraw_from_bridge_action(w, act, i == 0)
    G.append({"name": f"withdraw3 {i}", "kind": "user", "primaryType": "HyperliquidTransaction:Withdraw", "action": act, "sig": s})
json.dump(out, open("tests/fixtures/hyperliquid/sign-vectors.json", "w"), indent=1)
print(len(O), "official,", len(G), "generated")
