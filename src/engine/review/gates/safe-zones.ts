// The Instagram Reels safe zones (Q32, decision: moved from study/perception-extensions.ts into the engine's post-render gate, B10). A text
// box that sits in the top header, the bottom controls or the right action rail is drawn where the app covers it. The coordinates are
// normalised to the frame (0 to 1). The gate evaluates this only when the on-screen text boxes were measured.

export interface SafeZoneBox {
  x: number; // 0.0 to 1.0 (normalized)
  y: number; // 0.0 to 1.0 (normalized)
  width: number;
  height: number;
}

export interface SafeZoneValidationResult {
  isSafe: boolean;
  violations: Array<{
    text: string;
    zone: "top_header" | "bottom_controls" | "right_action_rail";
    box: SafeZoneBox;
  }>;
}

// Instagram 9:16 Reels UI Obscured Regions (Normalized Coordinates)
export const INSTAGRAM_REELS_BLOCKED_REGIONS = {
  topHeaderMaxY: 0.12, // Top 12% reserved for profile/close bar
  bottomControlsMinY: 0.78, // Bottom 22% reserved for caption, audio pill, seekbar
  rightActionRailMinX: 0.86, // Right 14% reserved for like/comment/share/remix icons
} as const;

/**
 * Validates text overlay boxes against Instagram safe zones.
 */
export function validateReelsSafeZones(
  overlays: Array<{ text: string; box: SafeZoneBox }>
): SafeZoneValidationResult {
  const violations: SafeZoneValidationResult["violations"] = [];

  for (const overlay of overlays) {
    const { box, text } = overlay;
    const top = box.y;
    const bottom = box.y + box.height;
    const right = box.x + box.width;

    if (top < INSTAGRAM_REELS_BLOCKED_REGIONS.topHeaderMaxY) {
      violations.push({ text, zone: "top_header", box });
    } else if (bottom > INSTAGRAM_REELS_BLOCKED_REGIONS.bottomControlsMinY) {
      violations.push({ text, zone: "bottom_controls", box });
    } else if (right > INSTAGRAM_REELS_BLOCKED_REGIONS.rightActionRailMinX) {
      violations.push({ text, zone: "right_action_rail", box });
    }
  }

  return {
    isSafe: violations.length === 0,
    violations,
  };
}
