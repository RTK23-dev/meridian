// The product imagery of a product kit (Bible 13, L8). Pure. A product kit with no image cannot pin a hero frame, so the
// planner treats it as no product kit (planKitsOf): every type that needs the pinned image is then removed (7.2 rules 2, 6).

import type { ProductKit } from "../contracts/index.ts";

/** Every image URI of the kit that may show the product: the hero images, then the cutouts, in kit order, without repeats. */
export function productImageUris(kit: ProductKit): string[] {
  const uris = [...kit.heroImages.map((image) => image.uri), ...kit.cutouts];
  return uris.filter((uri, index) => uris.indexOf(uri) === index);
}

/**
 * The hero frame a product shot pins (7.1 product_hero, 6.4): the front view when the kit has one, else the first hero image,
 * else the first cutout. Null when the kit has no image at all.
 */
export function heroUriOf(kit: ProductKit): string | null {
  const front = kit.heroImages.find((image) => image.angle === "front");
  return front?.uri ?? kit.heroImages[0]?.uri ?? kit.cutouts[0] ?? null;
}
