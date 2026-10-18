import type { Catalog } from '../types.js';
import { withPacks } from './packs.js';
import { withRecommendations } from './recommended.js';
import { withTrending } from './trending.js';

/** The catalog as every interface shows it: Recommended, then Trending, then the packs, then the themes. */
export function curated(catalog: Catalog): Catalog {
  return withPacks(withTrending(withRecommendations(catalog)));
}
