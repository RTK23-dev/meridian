function channel(value: number): number {
  const unit = value / 255;
  return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
}

export function contrastRatio(foreground: string, background: string): number {
  const ratio = (lighter: number, darker: number) => (lighter + 0.05) / (darker + 0.05);
  const left = luminance(foreground);
  const right = luminance(background);
  const value = left > right ? ratio(left, right) : ratio(right, left);
  return Math.round(value * 100) / 100;
}

function luminance(hex: string): number {
  const normalized = hex.replace("#", "");
  const color = Number.parseInt(normalized, 16);
  const red = channel((color >> 16) & 255);
  const green = channel((color >> 8) & 255);
  const blue = channel(color & 255);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}
