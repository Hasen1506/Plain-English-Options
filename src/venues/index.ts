// Registry of perp venues. Add a venue by implementing PerpVenue (types.ts) and
// appending it here; the Perps tab shows a venue picker once there are two.

import type { PerpVenue } from "./types.ts";
import { createDeriveVenue, type DeriveHost } from "./derive.ts";
import { createHyperliquidVenue, type HlHost } from "./hyperliquid/index.ts";

export interface VenueHosts {
  derive: DeriveHost;
  hyperliquid?: HlHost;
}

export function createVenues(h: VenueHosts): PerpVenue[] {
  const out: PerpVenue[] = [createDeriveVenue(h.derive)];
  if (h.hyperliquid) out.push(createHyperliquidVenue(h.hyperliquid));
  return out;
}

export type { PerpVenue } from "./types.ts";
