import type { Face, FontKey, MatchTier } from "./types";

export function keyOf(font: FontKey): string {
  return `${font.family}\u0000${font.style}`;
}

export type Match<T> = { ref: T; face: Face; tier: MatchTier };

/** "SemiBold", "Semibold", "Semi Bold" and "semi-bold" all become "semibold". */
export function normalizeStyle(style: string): string {
  return style.normalize("NFKC").toLowerCase().replace(/[\s\-_]+/g, "");
}

/** Spaces stay significant in families ("Inter Display" is not "InterDisplay"), only their runs collapse. */
export function normalizeFamily(family: string): string {
  return family.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizedKeyOf(family: string, style: string): string {
  return keyOf({ family: normalizeFamily(family), style: normalizeStyle(style) });
}

/**
 * Looks up Figma {family, style} pairs against parsed faces, in tiers:
 *   exact       family and style identical (how Figma itself matches)
 *   normalized  NFKC, case-folded; whitespace, "-" and "_" ignored in style, collapsed in family
 *               ("SemiBold" = "Semibold" = "Semi Bold")
 *   alias       the legacy pair (name IDs 1/2), or family + " " + style equal to the full name (ID 4)
 * The first tier with a hit wins; within a tier the first entry added wins.
 */
export class FaceIndex<T> {
  private readonly exact = new Map<string, Match<T>>();
  private readonly normalized = new Map<string, Match<T>>();
  private readonly alias = new Map<string, Match<T>>();

  constructor(entries: Iterable<{ face: Face; ref: T }>) {
    for (const { face, ref } of entries) {
      add(this.exact, keyOf(face), { ref, face, tier: "exact" });
      add(this.normalized, normalizedKeyOf(face.family, face.style), { ref, face, tier: "normalized" });
      const alias: Match<T> = { ref, face, tier: "alias" };
      if (face.legacyFamily !== null && face.legacyStyle !== null) {
        add(this.alias, normalizedKeyOf(face.legacyFamily, face.legacyStyle), alias);
      }
      // Index every family/style split of the full name, so {Roobert TRIAL, Heavy} finds a file
      // whose only names are {Roobert TRIAL Heavy, Regular} with full name "Roobert TRIAL Heavy".
      if (face.fullName !== null) {
        const words = normalizeFamily(face.fullName).split(" ");
        for (let i = 1; i < words.length; i++) {
          add(this.alias, normalizedKeyOf(words.slice(0, i).join(" "), words.slice(i).join(" ")), alias);
        }
      }
    }
  }

  match(query: FontKey): Match<T> | null {
    const normalized = normalizedKeyOf(query.family, query.style);
    return this.exact.get(keyOf(query)) ?? this.normalized.get(normalized) ?? this.alias.get(normalized) ?? null;
  }
}

function add<T>(map: Map<string, Match<T>>, key: string, match: Match<T>): void {
  if (!map.has(key)) map.set(key, match);
}
