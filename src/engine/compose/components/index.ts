// The component library (Bible 9.2). Claude picks a name and fills props; it never writes component code.
// E1 shipped the first five; E2 added react.layout, list.tierBoard, compare.split, price.reveal and chat.thread; E5 adds
// kinetic.type, screen.mock and character.rig; the chain work adds stopmotion.player (Bible 7.1, sourceBound). The rest
// of the Bible 9.2 list (list.countdown, list.ranking, and the others) arrives in later phases. captions.boxed is K21's.

import type { ComponentLibrary } from "../library.ts";
import { captionsBoxed } from "./captions.boxed/index.ts";
import { captionsKaraoke } from "./captions.karaoke/index.ts";
import { characterRig } from "./character.rig/index.ts";
import { chatThread } from "./chat.thread/index.ts";
import { compareSplit } from "./compare.split/index.ts";
import { ctaCard } from "./cta.card/index.ts";
import { kineticPunchline } from "./kinetic.punchline/index.ts";
import { kineticType } from "./kinetic.type/index.ts";
import { labelPill } from "./label.pill/index.ts";
import { listTierBoard } from "./list.tierBoard/index.ts";
import { panelBars } from "./panel.bars/index.ts";
import { panelLine } from "./panel.line/index.ts";
import { panelTiles } from "./panel.tiles/index.ts";
import { priceReveal } from "./price.reveal/index.ts";
import { productCard } from "./product.card/index.ts";
import { reactLayout } from "./react.layout/index.ts";
import { screenMock } from "./screen.mock/index.ts";
import { statCounter } from "./stat.counter/index.ts";
import { stopmotionPlayer } from "./stopmotion.player/index.ts";
import { titleHook } from "./title.hook/index.ts";

export const COMPONENT_LIBRARY: ComponentLibrary = Object.freeze({
  [captionsBoxed.name]: captionsBoxed,
  [captionsKaraoke.name]: captionsKaraoke,
  [titleHook.name]: titleHook,
  [kineticPunchline.name]: kineticPunchline,
  [productCard.name]: productCard,
  [ctaCard.name]: ctaCard,
  [reactLayout.name]: reactLayout,
  [listTierBoard.name]: listTierBoard,
  [compareSplit.name]: compareSplit,
  [panelBars.name]: panelBars,
  [panelLine.name]: panelLine,
  [panelTiles.name]: panelTiles,
  [priceReveal.name]: priceReveal,
  [chatThread.name]: chatThread,
  [kineticType.name]: kineticType,
  [labelPill.name]: labelPill,
  [screenMock.name]: screenMock,
  [characterRig.name]: characterRig,
  [stopmotionPlayer.name]: stopmotionPlayer,
  [statCounter.name]: statCounter,
});
