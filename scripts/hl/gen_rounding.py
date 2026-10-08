# Reference price/size rounding from the official SDK examples
# (hyperliquid-python-sdk examples/rounding.py: round(float(f"{px:.5g}"), 6 - szDecimals);
#  sizes: round(sz, szDecimals)), recorded for the differential test.
import json, random
r = random.Random(7)
rows = []
for i in range(600):
    szd = r.choice([0, 1, 2, 3, 4, 5])
    mag = r.uniform(-4, 5.3)
    px = 10 ** mag
    ref = round(float(f"{px:.5g}"), 6 - szd)
    sz = r.uniform(0, 1000) / (10 ** r.randint(0, 4))
    rows.append({"px": repr(px), "szDecimals": szd, "refPx": repr(ref), "sz": repr(sz), "refSz": repr(round(sz, szd))})
json.dump({"source": "hyperliquid-python-sdk examples/rounding.py formula", "rows": rows}, open("tests/fixtures/hyperliquid/rounding-ref.json", "w"))
print(len(rows))
