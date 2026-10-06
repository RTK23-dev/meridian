import { PNG } from "pngjs";

export type LogoMeasurement = {
  similarity: number | null;
  confidence: number | null;
  outcome: "MATCH" | "MISMATCH" | "UNCERTAIN" | "ABSENT";
  evidence: string;
};

export type PaletteMeasurement = {
  distance: number | null;
  confidence: number | null;
  outcome: "MATCH" | "MISMATCH" | "UNCERTAIN" | "ABSENT";
  extracted: string[];
  evidence: string;
};

function readPng(bytes: Uint8Array): PNG | null {
  try {
    const png = PNG.sync.read(Buffer.from(bytes));
    if (png.width < 2 || png.height < 2) return null;
    return png;
  } catch {
    return null;
  }
}

function luminance(png: PNG, x: number, y: number): number {
  const index = (png.width * y + x) * 4;
  return (png.data[index] ?? 0) * 0.3 + (png.data[index + 1] ?? 0) * 0.59 + (png.data[index + 2] ?? 0) * 0.11;
}

function averageHash(png: PNG): bigint {
  const cells = 8;
  const values: number[] = [];
  for (let y = 0; y < cells; y += 1) {
    for (let x = 0; x < cells; x += 1) {
      const sx = Math.min(png.width - 1, Math.floor((x + 0.5) * (png.width / cells)));
      const sy = Math.min(png.height - 1, Math.floor((y + 0.5) * (png.height / cells)));
      values.push(luminance(png, sx, sy));
    }
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  let hash = 0n;
  values.forEach((value, index) => {
    if (value >= mean) hash |= 1n << BigInt(index);
  });
  return hash;
}

function hamming(left: bigint, right: bigint): number {
  let bits = left ^ right;
  let count = 0;
  while (bits) {
    count += Number(bits & 1n);
    bits >>= 1n;
  }
  return count;
}

function regionHash(png: PNG, originX: number, originY: number, width: number, height: number): bigint {
  const cells = 8;
  const values: number[] = [];
  for (let y = 0; y < cells; y += 1) {
    for (let x = 0; x < cells; x += 1) {
      const sx = Math.min(png.width - 1, originX + Math.floor((x + 0.5) * (width / cells)));
      const sy = Math.min(png.height - 1, originY + Math.floor((y + 0.5) * (height / cells)));
      values.push(luminance(png, sx, sy));
    }
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  let hash = 0n;
  values.forEach((value, index) => {
    if (value >= mean) hash |= 1n << BigInt(index);
  });
  return hash;
}

/** Compares stored logo PNG bytes with candidate PNG bytes. Unreadable bytes stay uncertain. */
export function measureLogo(logo: Uint8Array | null, creative: Uint8Array): LogoMeasurement {
  if (!logo || logo.byteLength < 8) {
    return {
      similarity: null,
      confidence: null,
      outcome: "ABSENT",
      evidence: "No stored logo bytes. Similarity was not invented.",
    };
  }
  const mark = readPng(logo);
  const frame = readPng(creative);
  if (!mark || !frame) {
    return {
      similarity: null,
      confidence: null,
      outcome: "UNCERTAIN",
      evidence: "Logo comparison needs readable PNG bytes. The file was not treated as a match.",
    };
  }
  const logoHash = averageHash(mark);
  const width = Math.min(mark.width, frame.width);
  const height = Math.min(mark.height, frame.height);
  let best = 64;
  const stepX = Math.max(1, Math.floor(width / 2));
  const stepY = Math.max(1, Math.floor(height / 2));
  let checked = 0;
  for (let y = 0; y + height <= frame.height && checked < 24; y += stepY) {
    for (let x = 0; x + width <= frame.width && checked < 24; x += stepX) {
      best = Math.min(best, hamming(logoHash, regionHash(frame, x, y, width, height)));
      checked += 1;
    }
  }
  if (frame.width === mark.width && frame.height === mark.height) {
    best = Math.min(best, hamming(logoHash, averageHash(frame)));
  }
  const similarity = Math.round((1 - best / 64) * 1000) / 1000;
  const confidence = checked > 0 ? Math.min(0.9, 0.4 + checked / 40) : 0.3;
  if (best <= 8) {
    return {
      similarity,
      confidence,
      outcome: "MATCH",
      evidence: `Logo hash distance ${best} of 64 on stored PNG bytes. Similarity ${similarity.toFixed(2)}.`,
    };
  }
  if (best >= 28) {
    return {
      similarity,
      confidence,
      outcome: "MISMATCH",
      evidence: `Logo hash distance ${best} of 64. The stored mark is not in the creative.`,
    };
  }
  return {
    similarity,
    confidence,
    outcome: "UNCERTAIN",
    evidence: `Closest logo hash distance is ${best} of 64. Detection is not decisive.`,
  };
}

type Lab = { l: number; a: number; b: number };

function srgbToLab(red: number, green: number, blue: number): Lab {
  const channel = (value: number) => {
    const scaled = value / 255;
    const linear = scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
    return linear;
  };
  const r = channel(red);
  const g = channel(green);
  const b = channel(blue);
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const pivot = (value: number) => (value > 0.008856 ? Math.cbrt(value) : (7.787 * value) + 16 / 116);
  const fx = pivot(x);
  const fy = pivot(y);
  const fz = pivot(z);
  return { l: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

function hexToLab(hex: string): Lab | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match?.[1]) return null;
  const raw = match[1];
  return srgbToLab(Number.parseInt(raw.slice(0, 2), 16), Number.parseInt(raw.slice(2, 4), 16), Number.parseInt(raw.slice(4, 6), 16));
}

function deltaE(left: Lab, right: Lab): number {
  return Math.hypot(left.l - right.l, left.a - right.a, left.b - right.b);
}

function dominantLabs(png: PNG): Lab[] {
  const buckets = new Map<string, { lab: Lab; count: number }>();
  const step = Math.max(1, Math.floor((png.width * png.height) / 400));
  for (let index = 0; index < png.width * png.height; index += step) {
    const offset = index * 4;
    const alpha = png.data[offset + 3] ?? 255;
    if (alpha < 16) continue;
    const lab = srgbToLab(png.data[offset] ?? 0, png.data[offset + 1] ?? 0, png.data[offset + 2] ?? 0);
    const key = `${Math.round(lab.l / 8)}:${Math.round(lab.a / 8)}:${Math.round(lab.b / 8)}`;
    const current = buckets.get(key);
    if (current) current.count += 1;
    else buckets.set(key, { lab, count: 1 });
  }
  return [...buckets.values()]
    .sort((left, right) => right.count - left.count)
    .slice(0, 4)
    .map((bucket) => bucket.lab);
}

function labHex(lab: Lab): string {
  return `L${Math.round(lab.l)}a${Math.round(lab.a)}b${Math.round(lab.b)}`;
}

/**
 * Dominant creative colors in CIE Lab against stored brand hex colors.
 * No hex palette, or unreadable bytes, stays uncertain. Raw RGB averages are not the score.
 */
export function measurePalette(brandColors: string, creative: Uint8Array): PaletteMeasurement {
  const brand = brandColors
    .split(/[\s,;]+/)
    .map(hexToLab)
    .filter((color): color is Lab => color !== null);
  const png = readPng(creative);
  if (!png) {
    return {
      distance: null,
      confidence: null,
      outcome: "UNCERTAIN",
      extracted: [],
      evidence: "Palette measurement needs readable PNG bytes.",
    };
  }
  const extractedLabs = dominantLabs(png);
  const extracted = extractedLabs.map(labHex);
  if (brand.length === 0) {
    return {
      distance: null,
      confidence: null,
      outcome: "ABSENT",
      extracted,
      evidence: extracted.length
        ? `Extracted ${extracted.join(", ")}. No brand hex colors are stored, so distance was not scored.`
        : "No brand hex colors are stored.",
    };
  }
  if (extractedLabs.length === 0) {
    return {
      distance: null,
      confidence: null,
      outcome: "UNCERTAIN",
      extracted: [],
      evidence: "The PNG had no opaque pixels to measure.",
    };
  }
  const distances = extractedLabs.map((color) => Math.min(...brand.map((swatch) => deltaE(color, swatch))));
  const mean = distances.reduce((sum, value) => sum + value, 0) / distances.length;
  const normalized = Math.round(Math.min(1, mean / 100) * 1000) / 1000;
  const spread = Math.max(...distances) - Math.min(...distances);
  if (mean <= 18) {
    return {
      distance: normalized,
      confidence: 0.8,
      outcome: "MATCH",
      extracted,
      evidence: `Mean CIE76 distance to the stored palette is ${mean.toFixed(1)}. Extracted ${extracted.join(", ")}.`,
    };
  }
  if (mean >= 45 && spread < 30) {
    return {
      distance: normalized,
      confidence: 0.75,
      outcome: "MISMATCH",
      extracted,
      evidence: `Mean CIE76 distance to the stored palette is ${mean.toFixed(1)}. The creative palette does not match.`,
    };
  }
  return {
    distance: normalized,
    confidence: 0.4,
    outcome: "UNCERTAIN",
    extracted,
    evidence: `Mean CIE76 distance is ${mean.toFixed(1)} with spread ${spread.toFixed(1)}. The palette is not decisive.`,
  };
}

function strictest<T extends { outcome: string; evidence: string }>(frames: T[], empty: T): T {
  if (frames.length === 0) return empty;
  const order = ["MISMATCH", "UNCERTAIN", "ABSENT", "MATCH"];
  const chosen = order.map((outcome) => frames.find((item) => item.outcome === outcome)).find((item) => item != null) ?? frames[0];
  if (!chosen) return empty;
  return { ...chosen, evidence: `${frames.length} frame(s) measured. ${chosen.evidence}` };
}

/** A mismatch or an uncertain frame blocks a match on another frame. */
export function combineLogoFrames(frames: LogoMeasurement[]): LogoMeasurement {
  return strictest(frames, {
    similarity: null,
    confidence: null,
    outcome: "ABSENT",
    evidence: "No sampled frame was stored. Logo presence was not invented.",
  });
}

export function combinePaletteFrames(frames: PaletteMeasurement[]): PaletteMeasurement {
  return strictest(frames, {
    distance: null,
    confidence: null,
    outcome: "ABSENT",
    extracted: [],
    evidence: "No sampled frame was stored. Palette distance was not invented.",
  });
}
