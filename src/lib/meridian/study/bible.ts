/**
 * The 11-Dimension Angle Bible
 * Replaces fixed-window 6-beat ad schemas with a structured, versioned framework
 * representing authentic short-form video creative architecture.
 */

export interface AngleBibleEntry {
  slug: string;
  dimensionId: number;
  dimensionName: string;
  name: string;
  definition: string;
  onScreenCues: string[];
  psychologicalMechanism: string;
  applicableNiches: string[];
  naturalProductEntryPoints: string[];
  failureModes: string[];
  predictiveWeight: number;
}

export interface AngleBibleDimension {
  id: number;
  name: string;
  description: string;
  entries: AngleBibleEntry[];
}

export const ANGLE_BIBLE_DIMENSIONS: AngleBibleDimension[] = [
  {
    id: 1,
    name: "Hook Mechanism",
    description: "The cognitive grab occurring in frames 0 to 45 (first 1.5 seconds).",
    entries: [
      {
        slug: "result-first",
        dimensionId: 1,
        dimensionName: "Hook Mechanism",
        name: "Result First / Payoff Tease",
        definition: "Displays the finished outcome or dramatic climax in the opening frame.",
        onScreenCues: ["Finished hairstyle/skin result", "Final high-energy dish", "App dashboard finished view"],
        psychologicalMechanism: "Eliminates doubt; hooks viewer anticipation to learn the methodology.",
        applicableNiches: ["beauty", "fitness", "saas", "cooking", "diy"],
        naturalProductEntryPoints: ["How we got this in 3 minutes", "The exact routine"],
        failureModes: ["Boring outcome", "Reveal too fast with no loop"],
        predictiveWeight: 1.0,
      },
      {
        slug: "negative-inversion",
        dimensionId: 1,
        dimensionName: "Hook Mechanism",
        name: "Negative Inversion / Stop Doing X",
        definition: "Commands the user to immediately cease a ubiquitous everyday behavior.",
        onScreenCues: ["Stop doing X", "You are wasting your time with...", "Never buy Y until..."],
        psychologicalMechanism: "Triggers loss aversion and immediate cognitive pause.",
        applicableNiches: ["fitness", "finance", "skincare", "marketing", "productivity"],
        naturalProductEntryPoints: ["Replace it with this protocol", "The modern alternative"],
        failureModes: ["Too hostile", "Inauthentic fear mongering"],
        predictiveWeight: 1.0,
      },
      {
        slug: "pov-relatable",
        dimensionId: 1,
        dimensionName: "Hook Mechanism",
        name: "POV In-Medias-Res",
        definition: "Places the viewer immediately in the center of a tense or hilarious relatable scenario.",
        onScreenCues: ["POV: You just...", "Actors mid-conversation", "Facial expression of shock"],
        psychologicalMechanism: "Mirror neuron resonance and empathy activation.",
        applicableNiches: ["lifestyle", "dating", "e-commerce", "workplace", "wellness"],
        naturalProductEntryPoints: ["Unintentional discovery by protagonist", "Third-party intervention"],
        failureModes: ["Over-acted cringe", "Unclear perspective"],
        predictiveWeight: 1.0,
      },
    ],
  },
  {
    id: 2,
    name: "Format Structure",
    description: "The macroscopic storytelling and delivery archetype.",
    entries: [
      {
        slug: "pov-skit",
        dimensionId: 2,
        dimensionName: "Format Structure",
        name: "POV Relatable Skit",
        definition: "Short multi-character dramatization showing common pains and comedic truths.",
        onScreenCues: ["Two-character jump cuts", "Props representing different roles", "Internal monologue voiceover"],
        psychologicalMechanism: "Humor lowers skepticism defenses, enabling organic brand placement.",
        applicableNiches: ["lifestyle", "workplace", "supplements", "saas"],
        naturalProductEntryPoints: ["The character who has their life together uses it"],
        failureModes: ["Too long", "Weak punchline"],
        predictiveWeight: 1.0,
      },
      {
        slug: "myth-vs-fact",
        dimensionId: 2,
        dimensionName: "Format Structure",
        name: "Myth vs. Fact Breakdown",
        definition: "Debunks common industry misconceptions side-by-side with empirical proof.",
        onScreenCues: ["Split screen", "Red X vs Green Checkmark", "Citing lab results or ingredients"],
        psychologicalMechanism: "Authority establishment through educational revelation.",
        applicableNiches: ["skincare", "nutrition", "finance", "tech"],
        naturalProductEntryPoints: ["The only formula that actually fixes the root cause"],
        failureModes: ["Academic and boring", "Debunking trivial points"],
        predictiveWeight: 1.0,
      },
      {
        slug: "transformation-arc",
        dimensionId: 2,
        dimensionName: "Format Structure",
        name: "Transformation / Day 1 vs Day 30",
        definition: "Time-lapse or progress progression documenting real transformation over time.",
        onScreenCues: ["Day 1 / Day 14 / Day 30 timestamps", "Side-by-side comparison shots"],
        psychologicalMechanism: "Proof of efficacy via verifiable journey documentation.",
        applicableNiches: ["fitness", "beauty", "habits", "gardening"],
        naturalProductEntryPoints: ["Core catalyst responsible for the shift"],
        failureModes: ["Suspiciously fast transformation", "Inconsistent lighting"],
        predictiveWeight: 1.0,
      },
    ],
  },
  {
    id: 3,
    name: "Emotional Driver",
    description: "Primary emotional state evoked in the viewer.",
    entries: [
      {
        slug: "cathartic-relief",
        dimensionId: 3,
        dimensionName: "Emotional Driver",
        name: "Cathartic Relief",
        definition: "The feeling of finally solving an exhausting, long-standing frustration.",
        onScreenCues: ["Deep sigh", "Before-state chaos transitioning to serenity", "Finally text"],
        psychologicalMechanism: "Release of chronic tension creates immediate brand affinity.",
        applicableNiches: ["organization", "productivity", "pain-relief", "skincare"],
        naturalProductEntryPoints: ["The breakthrough tool"],
        failureModes: ["Felt simulated rather than earned"],
        predictiveWeight: 1.0,
      },
      {
        slug: "social-validation",
        dimensionId: 3,
        dimensionName: "Emotional Driver",
        name: "Social Validation & Belonging",
        definition: "Feeling seen and affirmed in an experience others normally overlook.",
        onScreenCues: ["Please tell me I'm not the only one", "Who else does this?"],
        psychologicalMechanism: "Validates identity, driving comments and shares to peers.",
        applicableNiches: ["lifestyle", "parenting", "fitness", "dating"],
        naturalProductEntryPoints: ["The community ritual"],
        failureModes: ["Too niche to register"],
        predictiveWeight: 1.0,
      },
    ],
  },
  {
    id: 4,
    name: "Retention Architecture",
    description: "Structural pacing mechanisms sustaining watch time through the second-by-second curve.",
    entries: [
      {
        slug: "continuous-open-loop",
        dimensionId: 4,
        dimensionName: "Retention Architecture",
        name: "Continuous Open Loop",
        definition: "Promises an impending reveal or secret that is delayed until the final 3 seconds.",
        onScreenCues: ["Wait until the end", "Number 3 changed everything", "I wasn't ready for what happened next"],
        psychologicalMechanism: "Zeigarnik effect: cognitive itch demands resolution.",
        applicableNiches: ["all"],
        naturalProductEntryPoints: ["The final reveal item is the product"],
        failureModes: ["Disappointing payoff causes anger comments and skips"],
        predictiveWeight: 1.0,
      },
      {
        slug: "seamless-loop",
        dimensionId: 4,
        dimensionName: "Retention Architecture",
        name: "Seamless Infinity Loop",
        definition: "The ending words and visuals match seamlessly with the opening hook frame.",
        onScreenCues: ["Ending sentence joins opening sentence grammatically", "Identical start/end visual frame"],
        psychologicalMechanism: "Tricks the brain into rewatching the first 5 seconds, doubling retention.",
        applicableNiches: ["all"],
        naturalProductEntryPoints: ["End-to-beginning cyclical routine"],
        failureModes: ["Clunky audio glitch breaks illusion"],
        predictiveWeight: 1.0,
      },
    ],
  },
  {
    id: 5,
    name: "Visual Craft",
    description: "Camera motion, grading, composition, and mobile safe zone optimization.",
    entries: [
      {
        slug: "organic-handheld-macro",
        dimensionId: 5,
        dimensionName: "Visual Craft",
        name: "Organic Handheld Macro",
        definition: "Slight natural camera drift with crisp macro close-ups of texture and application.",
        onScreenCues: ["Subtle camera breathing", "Texture visible in 1080p", "High CRI natural warm light"],
        psychologicalMechanism: "Signals authentic creator UGC rather than sterile polished corporate ad.",
        applicableNiches: ["beauty", "food", "hardware", "jewelry"],
        naturalProductEntryPoints: ["Application ritual"],
        failureModes: ["Shaky camera causing nausea"],
        predictiveWeight: 1.0,
      },
    ],
  },
  {
    id: 6,
    name: "Audio Direction",
    description: "Voiceover inflection, audio energy curve, sound design, and trending music beds.",
    entries: [
      {
        slug: "punchy-cadence-vo",
        dimensionId: 6,
        dimensionName: "Audio Direction",
        name: "Punchy Conversational Cadence",
        definition: "Paced between 150-180 WPM with clear micro-pauses at concept transitions.",
        onScreenCues: ["Natural breathing pauses", "Punchy consonant delivery", "Background music dipping -12dB under voice"],
        psychologicalMechanism: "High information density prevents attention wandering.",
        applicableNiches: ["all"],
        naturalProductEntryPoints: ["Key differentiator callout"],
        failureModes: ["Auctioneer monotone"],
        predictiveWeight: 1.0,
      },
    ],
  },
  {
    id: 7,
    name: "Persona and Point of View",
    description: "Identity and stance of the speaker.",
    entries: [
      {
        slug: "skeptic-converted",
        dimensionId: 7,
        dimensionName: "Persona and Point of View",
        name: "The Converted Skeptic",
        definition: "Host begins as an open critic of the category, then explains what proved them wrong.",
        onScreenCues: ["I thought this was completely fake", "I bought it to prove it didn't work"],
        psychologicalMechanism: "Bypasses consumer cynicism by leading with identical skepticism.",
        applicableNiches: ["supplements", "beauty", "tech gadgets", "courses"],
        naturalProductEntryPoints: ["The moment of conversion"],
        failureModes: ["Fake-sounding skepticism"],
        predictiveWeight: 1.0,
      },
    ],
  },
  {
    id: 8,
    name: "Share Trigger",
    description: "The psychological prompt that makes someone send the video to a friend or group chat.",
    entries: [
      {
        slug: "relational-tag-bait",
        dimensionId: 8,
        dimensionName: "Share Trigger",
        name: "Relational Tag Bait",
        definition: "Depicts an endearing flaw or quirky habit shared by couples, best friends, or coworkers.",
        onScreenCues: ["Send this to someone who does this", "Tag your friend who..."],
        psychologicalMechanism: "Used as a communication surrogate to initiate social interaction.",
        applicableNiches: ["relationships", "lifestyle", "work", "fitness"],
        naturalProductEntryPoints: ["Gift idea or shared ritual"],
        failureModes: ["Too generic"],
        predictiveWeight: 1.0,
      },
    ],
  },
  {
    id: 9,
    name: "Conversion Pattern",
    description: "How intent is monetized or driven into pipeline without feeling transactional.",
    entries: [
      {
        slug: "keyword-to-dm",
        dimensionId: 9,
        dimensionName: "Conversion Pattern",
        name: "Comment Keyword to Automated DM",
        definition: "Invites viewers to drop a 1-word comment to receive a full guide or link.",
        onScreenCues: ["Comment 'GLOW' and I'll send the full breakdown", "Type 'WORKOUT' below"],
        psychologicalMechanism: "Low-friction action boosts comment algorithmic distribution while capturing intent.",
        applicableNiches: ["saas", "creator business", "fitness", "beauty"],
        naturalProductEntryPoints: ["DM contains the exact link and breakdown"],
        failureModes: ["Spam trigger"],
        predictiveWeight: 1.0,
      },
    ],
  },
  {
    id: 10,
    name: "Trend Context",
    description: "Algorithmic momentum and cultural meme integration.",
    entries: [
      {
        slug: "rising-audio-template",
        dimensionId: 10,
        dimensionName: "Trend Context",
        name: "Rising Audio Template",
        definition: "Audio track with < 5k existing reels growing > 20% day-over-day.",
        onScreenCues: ["Trending upward arrow next to audio", "Distinct timing cue on sound drop"],
        psychologicalMechanism: "Rides platform recommendation algorithm momentum.",
        applicableNiches: ["all"],
        naturalProductEntryPoints: ["Sound drop coincides with product reveal"],
        failureModes: ["Late to trend"],
        predictiveWeight: 1.0,
      },
    ],
  },
  {
    id: 11,
    name: "Product Integration Angle",
    description: "How the commercial brand or product naturally enters the narrative.",
    entries: [
      {
        slug: "accidental-co-star",
        dimensionId: 11,
        dimensionName: "Product Integration Angle",
        name: "The Accidental Co-Star",
        definition: "The product is actively in use throughout the video, but never mentioned until the final seconds.",
        onScreenCues: ["Product visible on counter", "Subject sips/applies naturally while speaking on unrelated topic"],
        psychologicalMechanism: "Curiosity loop drives comment section queries asking 'What is that on your desk?'.",
        applicableNiches: ["beverage", "beauty", "desk accessories", "fashion"],
        naturalProductEntryPoints: ["Pinned comment answering the questions"],
        failureModes: ["Product too hidden to notice"],
        predictiveWeight: 1.0,
      },
    ],
  },
];

/**
 * Retrieves a Bible entry by slug across all dimensions.
 */
export function getBibleEntryBySlug(slug: string): AngleBibleEntry | null {
  for (const dim of ANGLE_BIBLE_DIMENSIONS) {
    const entry = dim.entries.find((e) => e.slug === slug);
    if (entry) return entry;
  }
  return null;
}

/**
 * Retrieves all entries applicable to a specific niche.
 */
export function getBibleEntriesForNiche(niche: string): AngleBibleEntry[] {
  const result: AngleBibleEntry[] = [];
  const lower = niche.toLowerCase();
  for (const dim of ANGLE_BIBLE_DIMENSIONS) {
    for (const entry of dim.entries) {
      if (entry.applicableNiches.includes("all") || entry.applicableNiches.some((n) => lower.includes(n))) {
        result.push(entry);
      }
    }
  }
  return result;
}
