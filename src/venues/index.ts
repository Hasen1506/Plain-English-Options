// Registry of perp venues. Add a venue by implementing PerpVenue (types.ts) and
// appending it here; the Perps tab shows a venue picker once there are two.

import type { PerpVenue } from "./types.ts";
import { createDeriveVenue, type DeriveHost } from "./derive.ts";

export interface VenueHosts {
  derive: DeriveHost;
}

export function createVenues(h: VenueHosts): PerpVenue[] {
  return [createDeriveVenue(h.derive)];
}

export type { PerpVenue } from "./types.ts";
