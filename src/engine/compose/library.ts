// The component library's shape (Bible 9.2). A component is a template file plus a zod props schema. Claude never
// writes component code: it chooses a name and fills props, and the compiler checks the props before anything renders.

import type { z } from "zod";

/**
 * One prop set used for tests and golden frames. framesMs are times (ms from the clip start) to check. sourceUris is
 * the list of media URIs the clip's shot produced; the golden harness passes it to the compiler for a sourceBound
 * component (every fixture of such a component must set it).
 */
export type ComponentFixture = {
  name: string;
  durationMs: number;
  props: Record<string, unknown>;
  framesMs: number[];
  sourceUris?: string[];
};

export type ComponentDefinition = {
  /** The component name used by the EDL, e.g. "captions.karaoke". Also the template's composition id. */
  name: string;
  /** The exact text of component.html. It is copied into the composition unchanged. */
  template: string;
  /** Props schema. It includes the reserved `durationMs`, which the compiler sets from the clip span. */
  propsSchema: z.ZodType;
  /** Scalar props that the template declares in data-composition-variables (structured props are not declared). */
  declaredVariables: string[];
  fixtures: ComponentFixture[];
  /**
   * When true, every media URI in the clip's props must be one of the URIs its own shot produced. The caller passes
   * those URIs to compile() per clip (CompileOptions.clipSourceUris). A clip without them is refused: fail closed.
   * Used by stopmotion.player (Bible 7.1), whose frames are the outputs of the shot's own image calls.
   */
  sourceBound?: boolean;
};

export type ComponentLibrary = Readonly<Record<string, ComponentDefinition>>;

/** Props the compiler sets itself. A component's schema must accept it. */
export const RESERVED_PROP_DURATION = "durationMs";
