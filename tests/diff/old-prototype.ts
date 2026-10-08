// Pulls the OLD prototype's pricing code verbatim out of the archived
// index.html (tests/fixtures/old-prototype.html) and evaluates it with the
// closure variables it expects, so old and new can be compared directly.
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../fixtures/old-prototype.html", import.meta.url), "utf8");

/** Text of `function name(...) { ... }` with balanced braces. */
export function extractFunction(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`old prototype has no function ${name}`);
  let i = src.indexOf("{", start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error("unbalanced " + name);
}
/** One `const name = ...;` line. */
export function extractConst(src: string, name: string): string {
  const m = new RegExp(`const ${name} = [^\\n]*;`).exec(src);
  if (!m) throw new Error(`old prototype has no const ${name}`);
  return m[0];
}

export const OLD_SOURCE = [
  extractFunction(html, "erf"),
  extractConst(html, "N"),
  extractFunction(html, "bs"),
  extractConst(html, "usable"),
  extractFunction(html, "liveQuote"),
  extractFunction(html, "liveChance"),
  extractFunction(html, "chanceAt"),
].join("\n");

export interface OldEnv {
  S: { amt: number; asset: string; dir: "up" | "down"; tgt: number; date: number };
  INST: Record<string, unknown[]>;
  DATES: { key?: string; e?: number; days: number }[];
  ASSETS: Record<string, { p: number; iv: number }>;
  tk: Record<string, unknown> | null;
  spot: number;
}

export interface OldFns {
  erf(x: number): number;
  N(x: number): number;
  bs(S: number, K: number, T: number, v: number): { call: number; put: number; d2: number };
  liveQuote(): null | { valid: boolean; K1: number; K2: number; W: number; D: number; n: number; cost: number; p1: number; p2: number; chance: number; mark: boolean; i1: string; i2: string; dfee: number };
  liveChance(d: unknown, tk: unknown, f?: number): number | null;
}

export function loadOld(env: OldEnv): OldFns {
  const ymd = (name: string) => name.split("-")[1];
  const liveTk = () => (env.tk ? { tk: env.tk, t: 0 } : null);
  const spot = () => env.spot;
  const factory = new Function(
    "S",
    "INST",
    "DATES",
    "ASSETS",
    "ymd",
    "liveTk",
    "spot",
    `${OLD_SOURCE}\nreturn { erf, N, bs, liveQuote, liveChance, chanceAt };`,
  );
  return factory(env.S, env.INST, env.DATES, env.ASSETS, ymd, liveTk, spot) as OldFns;
}
