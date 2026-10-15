// The component library (Bible 9.2). Claude picks a name and fills props; it never writes component code.
// E1 shipped the first five; E2 added react.layout, list.tierBoard, compare.split, price.reveal and chat.thread; E5 adds
// kinetic.type, screen.mock and character.rig. The rest of the Bible 9.2 list (captions.boxed, list.countdown, list.ranking,
// and the others) arrives in later phases.

import type { ComponentLibrary } from "../library.ts";
import { captionsKaraoke } from "./captions.karaoke/index.ts";
import { characterRig } from "./character.rig/index.ts";
import { chatThread } from "./chat.thread/index.ts";
import { compareSplit } from "./compare.split/index.ts";
import { ctaCard } from "./cta.card/index.ts";
import { kineticPunchline } from "./kinetic.punchline/index.ts";
import { kineticType } from "./kinetic.type/index.ts";
import { listTierBoard } from "./list.tierBoard/index.ts";
import { priceReveal } from "./price.reveal/index.ts";
import { productCard } from "./product.card/index.ts";
import { reactLayout } from "./react.layout/index.ts";
import { screenMock } from "./screen.mock/index.ts";
import { titleHook } from "./title.hook/index.ts";

export const COMPONENT_LIBRARY: ComponentLibrary = Object.freeze({
  [captionsKaraoke.name]: captionsKaraoke,
  [titleHook.name]: titleHook,
  [kineticPunchline.name]: kineticPunchline,
  [productCard.name]: productCard,
  [ctaCard.name]: ctaCard,
  [reactLayout.name]: reactLayout,
  [listTierBoard.name]: listTierBoard,
  [compareSplit.name]: compareSplit,
  [priceReveal.name]: priceReveal,
  [chatThread.name]: chatThread,
  [kineticType.name]: kineticType,
  [screenMock.name]: screenMock,
  [characterRig.name]: characterRig,
});
