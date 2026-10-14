// The component library v1 (Bible 9.2). Claude picks a name and fills props; it never writes component code.
// Only the five E1 components are here. The rest of the Bible 9.2 list arrives in E2 and E5.

import type { ComponentLibrary } from "../library.ts";
import { captionsKaraoke } from "./captions.karaoke/index.ts";
import { ctaCard } from "./cta.card/index.ts";
import { kineticPunchline } from "./kinetic.punchline/index.ts";
import { productCard } from "./product.card/index.ts";
import { titleHook } from "./title.hook/index.ts";

export const COMPONENT_LIBRARY: ComponentLibrary = Object.freeze({
  [captionsKaraoke.name]: captionsKaraoke,
  [titleHook.name]: titleHook,
  [kineticPunchline.name]: kineticPunchline,
  [productCard.name]: productCard,
  [ctaCard.name]: ctaCard,
});
