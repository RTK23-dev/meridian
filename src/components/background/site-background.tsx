import { useEffect, useRef } from "react";
import { WORLD_FIELD_BITS } from "./world-field";
import { GLIDE, STOP_LATITUDES, decodeField, type StopId } from "./map-model";
import { HALFTONE_DEFAULTS, drawHalftone } from "./halftone";

/**
 * The site background behind every page: the world as a square halftone, the meridian line and the grain. The map sits at the stop the page
 * is on, and glides to a new stop when the page changes. It is drawn behind the content (negative z-index), so the page sits on it. With
 * reduced motion the map changes at once. The ground and the line come from the page's tokens, so the map follows the theme.
 */
export function SiteBackground({ stop }: { stop: StopId }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const grainRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef<number>(STOP_LATITUDES[stop]);

  // The latitude the map glides to. The loop below reads it each frame.
  useEffect(() => {
    targetRef.current = STOP_LATITUDES[stop];
  }, [stop]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const root = document.documentElement;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    const field = decodeField(WORLD_FIELD_BITS);
    let current = targetRef.current;
    let version = 0;
    let lastKey = "";
    let frame = 0;
    let palette = readPalette(root);

    // The canvas is sized to the window at the screen's pixel density, so every block is drawn sharp.
    const sizeCanvas = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(window.innerWidth * dpr);
      canvas.height = Math.round(window.innerHeight * dpr);
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      version += 1;
    };
    const onScheme = () => {
      palette = readPalette(root);
      version += 1;
    };
    const tick = () => {
      const target = targetRef.current;
      current = reduce.matches ? target : current + (target - current) * GLIDE;
      if (Math.abs(target - current) < 1e-4) current = target;
      const width = window.innerWidth;
      const height = window.innerHeight;
      const key = `${current.toFixed(3)}|${version}|${width}x${height}`;
      if (key !== lastKey) {
        drawHalftone(ctx, field, { width, height, centreLat: current, zoom: HALFTONE_DEFAULTS.zoom }, HALFTONE_DEFAULTS, palette);
        lastKey = key;
      }
      frame = requestAnimationFrame(tick);
    };

    sizeCanvas();
    const scheme = window.matchMedia("(prefers-color-scheme: light)");
    const observer = new MutationObserver(onScheme);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    window.addEventListener("resize", sizeCanvas);
    scheme.addEventListener("change", onScheme);
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", sizeCanvas);
      scheme.removeEventListener("change", onScheme);
    };
  }, []);

  // The grain: a static speckle tile at low opacity. It does not move, and it is made once.
  useEffect(() => {
    const layer = grainRef.current;
    if (!layer) return;
    const tile = document.createElement("canvas");
    tile.width = 160;
    tile.height = 160;
    const g = tile.getContext("2d");
    if (!g) return;
    const img = g.createImageData(160, 160);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = Math.random() < 0.5 ? 0 : 255;
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    layer.style.backgroundImage = `url(${tile.toDataURL()})`;
    layer.style.backgroundSize = "160px 160px";
  }, []);

  return (
    <>
      <canvas ref={canvasRef} className="site-map" aria-hidden="true" />
      <div className="site-meridian" aria-hidden="true" />
      <div ref={grainRef} className="site-grain" aria-hidden="true" />
    </>
  );
}

/** The ground and the line, read from the page's tokens as CSS colour strings. */
function readPalette(root: HTMLElement): { bg: string; line: string } {
  const style = getComputedStyle(root);
  return { bg: style.getPropertyValue("--map-bg").trim(), line: style.getPropertyValue("--map-line").trim() };
}
