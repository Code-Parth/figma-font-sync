/** Figma's identity for a font. The Plugin API exposes nothing else (no PostScript name). */
export type FontKey = { family: string; style: string };

/** One face as Figma would list it: a static face, a TTC member, or a variable-font named instance. */
export type Face = FontKey & {
  /** Name ID 6 for static faces, the instance PostScript name for variable instances; null when absent. */
  postscript: string | null;
  /** Name ID 4. */
  fullName: string | null;
  /** Name IDs 1 and 2, kept for alias matching against files saved with legacy names. */
  legacyFamily: string | null;
  legacyStyle: string | null;
  /** OS/2 usWeightClass, or the wght coordinate for a variable instance. */
  weight: number;
  italic: boolean;
  variable: boolean;
};

export type FontFormat = "ttf" | "otf" | "ttc";

export type ParsedFont = { format: FontFormat; faces: Face[] };

export type MatchTier = "exact" | "normalized" | "alias";
