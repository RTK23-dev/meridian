import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * The class merge for the design system. It knows the type scale, so a size such as text-small is kept next to a
 * colour such as text-fg instead of being read as a second colour and dropped.
 */
const merge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["eyebrow", "section", "title", "heading", "body", "small", "caption", "button", "data-l", "data-m", "data-s"] }],
    },
  },
});

export function cn(...values: ClassValue[]): string {
  return merge(clsx(values));
}
