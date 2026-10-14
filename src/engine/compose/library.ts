// The component library's shape (Bible 9.2). A component is a template file plus a zod props schema. Claude never
// writes component code: it chooses a name and fills props, and the compiler checks the props before anything renders.

import type { z } from "zod";

/** One prop set used for tests and golden frames. framesMs are times (ms from the clip start) to check. */
export type ComponentFixture = {
  name: string;
  durationMs: number;
  props: Record<string, unknown>;
  framesMs: number[];
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
};

export type ComponentLibrary = Readonly<Record<string, ComponentDefinition>>;

/** Props the compiler sets itself. A component's schema must accept it. */
export const RESERVED_PROP_DURATION = "durationMs";
