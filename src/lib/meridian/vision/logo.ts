import { PNG } from "pngjs";

export type LogoEvidence = {
  sufficient: boolean;
  distance: number | null;
  confidence: number | null;
  hint: "MATCH" | "MISMATCH" | "INSUFFICIENT";
  decision: "HUMAN_REVIEW" | "REJECT";
  reason: string;
};

function averageHash(bytes: Buffer): bigint | null {
  let png: PNG;
  try {
    png = PNG.sync.read(bytes);
  } catch {
    return null;
  }
  if (png.width < 2 || png.height < 2) return null;
  const cells = 8;
  const values: number[] = [];
  for (let y = 0; y < cells; y += 1) {
    for (let x = 0; x < cells; x += 1) {
      const sx = Math.min(png.width - 1, Math.floor((x + 0.5) * (png.width / cells)));
      const sy = Math.min(png.height - 1, Math.floor((y + 0.5) * (png.height / cells)));
      const index = (png.width * sy + sx) * 4;
      const red = png.data[index] ?? 0;
      const green = png.data[index + 1] ?? 0;
      const blue = png.data[index + 2] ?? 0;
      values.push(red * 0.3 + green * 0.59 + blue * 0.11);
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

function averageColor(bytes: Buffer): { red: number; green: number; blue: number } | null {
  let png: PNG;
  try {
    png = PNG.sync.read(bytes);
  } catch {
    return null;
  }
  if (png.width < 2 || png.height < 2) return null;
  let red = 0;
  let green = 0;
  let blue = 0;
  const pixels = png.width * png.height;
  for (let index = 0; index < pixels; index += 1) {
    red += png.data[index * 4] ?? 0;
    green += png.data[index * 4 + 1] ?? 0;
    blue += png.data[index * 4 + 2] ?? 0;
  }
  return { red: red / pixels, green: green / pixels, blue: blue / pixels };
}

/**
 * Pixel comparison against an approved PNG logo.
 * A missing or non-PNG file is insufficient and stays in human review.
 * A large color or hash distance is a reject. A close mark is evidence, not a publishing approval.
 */
export function compareLogoPng(approved: Uint8Array, creative: Uint8Array): LogoEvidence {
  const left = averageHash(Buffer.from(approved));
  const right = averageHash(Buffer.from(creative));
  const leftColor = averageColor(Buffer.from(approved));
  const rightColor = averageColor(Buffer.from(creative));
  if (left === null || right === null || !leftColor || !rightColor) {
    return {
      sufficient: false,
      distance: null,
      confidence: null,
      hint: "INSUFFICIENT",
      decision: "HUMAN_REVIEW",
      reason: "Logo comparison had no readable PNG bytes. Missing evidence does not approve the creative.",
    };
  }
  const distance = hamming(left, right);
  const colorDistance = Math.hypot(leftColor.red - rightColor.red, leftColor.green - rightColor.green, leftColor.blue - rightColor.blue);
  const confidence = Math.round((1 - distance / 64) * 1000) / 1000;
  if (distance >= 28 || colorDistance >= 80) {
    return {
      sufficient: true,
      distance,
      confidence,
      hint: "MISMATCH",
      decision: "REJECT",
      reason: `Approved logo hash distance is ${distance} of 64 and color distance is ${Math.round(colorDistance)}. The mark does not match.`,
    };
  }
  return {
    sufficient: true,
    distance,
    confidence,
    hint: distance <= 8 && colorDistance < 20 ? "MATCH" : "INSUFFICIENT",
    decision: "HUMAN_REVIEW",
    reason:
      distance <= 8 && colorDistance < 20
        ? `Approved logo hash distance is ${distance} of 64. The mark is close. Publishing still requires a person or a connected provider.`
        : `Approved logo hash distance is ${distance} of 64. The comparison is not decisive.`,
  };
}
