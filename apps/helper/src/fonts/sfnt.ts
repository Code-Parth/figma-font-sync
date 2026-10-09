import { keyOf } from "./match";
import type { Face, FontFormat, ParsedFont } from "./types";

export const MAX_FONT_BYTES = 50 * 1024 * 1024;

/** Message is shown to the user as-is. */
export class FontParseError extends Error {
  override name = "FontParseError";
}

/** `ttf`/`otf`/`ttc` for installable sfnt data, `web` for WOFF/WOFF2, `null` for anything else. */
export function sniffFormat(bytes: Uint8Array): FontFormat | "web" | null {
  if (bytes.byteLength < 4) return null;
  switch (tagAt(new DataView(bytes.buffer, bytes.byteOffset, 4), 0)) {
    case "ttcf":
      return "ttc";
    case "\0\x01\0\0":
    case "true":
      return "ttf";
    case "OTTO":
      return "otf";
    case "wOFF":
    case "wOF2":
      return "web";
    default:
      return null;
  }
}

/**
 * Faces exactly as Figma names them: family = name ID 16 else 1, style = name ID 17 else 2,
 * one face per fvar named instance (plus the default instance when no record matches it),
 * TTC members expanded, faces whose family starts with "." dropped.
 * Throws FontParseError for WOFF, non-sfnt, oversized, truncated or structurally invalid input.
 */
export function parseFont(bytes: Uint8Array): ParsedFont {
  if (bytes.byteLength > MAX_FONT_BYTES) {
    throw new FontParseError(`Font files larger than ${MAX_FONT_BYTES / 1024 / 1024} MB are not supported.`);
  }
  const format = sniffFormat(bytes);
  if (format === "web") throw new FontParseError("WOFF/WOFF2 is a web format; convert it to TTF or OTF first");
  if (format === null) throw new FontParseError("Not a TrueType or OpenType font file.");
  try {
    return { format, faces: readFaces(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), format) };
  } catch (error) {
    // Table views are cut to each table's extent, so any read past a structure's end lands here.
    if (error instanceof RangeError) throw new FontParseError("The font file is truncated or corrupt.");
    throw error;
  }
}

type Tables = Map<string, DataView>;

/**
 * Any one of these makes a face renderable. Apple bitmap fonts have no glyf or CFF, and macOS
 * PingFangUI.ttc carries its outlines only in Apple's 'hvgl'.
 */
const OUTLINE_TABLES = ["glyf", "CFF ", "CFF2", "hvgl", "sbix", "CBDT", "EBDT", "bdat"];

const NO_NAME = 0xffff;

const truncated = (): FontParseError => new FontParseError("The font file is truncated or corrupt.");

function tagAt(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

function readFaces(file: DataView, format: FontFormat): Face[] {
  const faces: Face[] = [];
  const seen = new Set<string>();
  let named = 0;
  for (const directory of directoryOffsets(file, format)) {
    const memberFaces = memberFacesOf(readDirectory(file, directory));
    if (!memberFaces) continue;
    named++;
    for (const face of memberFaces) {
      // Figma hides "."-prefixed system faces such as ".SF NS"; listing them would offer fonts nobody can pick.
      if (face.family.startsWith(".")) continue;
      const key = keyOf(face);
      if (seen.has(key)) continue;
      seen.add(key);
      faces.push(face);
    }
  }
  if (named === 0) throw new FontParseError("The font has no family name.");
  return faces;
}

function directoryOffsets(file: DataView, format: FontFormat): number[] {
  if (format !== "ttc") return [0];
  if (file.byteLength < 12) throw truncated();
  const count = file.getUint32(8);
  if (count === 0) throw new FontParseError("The font collection contains no fonts.");
  if (12 + 4 * count > file.byteLength) throw truncated();
  return Array.from({ length: count }, (_, i) => file.getUint32(12 + 4 * i));
}

/** Every table as a view of exactly its declared extent; tables must lie inside the file. */
function readDirectory(file: DataView, offset: number): Tables {
  if (offset + 12 > file.byteLength) throw truncated();
  const count = file.getUint16(offset + 4);
  if (offset + 12 + 16 * count > file.byteLength) throw truncated();
  const tables: Tables = new Map();
  for (let i = 0; i < count; i++) {
    const record = offset + 12 + 16 * i;
    const tag = tagAt(file, record);
    const start = file.getUint32(record + 8);
    const length = file.getUint32(record + 12);
    if (start + length > file.byteLength) throw truncated();
    if (!tables.has(tag)) tables.set(tag, new DataView(file.buffer, file.byteOffset + start, length));
  }
  for (const tag of ["name", "cmap"]) {
    if (!tables.has(tag)) throw new FontParseError(`The font has no '${tag}' table.`);
  }
  if (!OUTLINE_TABLES.some((tag) => tables.has(tag))) throw new FontParseError("The font has no glyph outlines.");
  return tables;
}

/** null when the member has no family name at all. */
function memberFacesOf(tables: Tables): Face[] | null {
  const name = tables.get("name");
  if (!name) return null;
  const names = readNames(name);
  const family = names.get(16) ?? names.get(1);
  if (!family) return null;

  const os2 = tables.get("OS/2");
  // Apple bitmap fonts carry 'bhed' instead of 'head', with the same layout.
  const head = tables.get("head") ?? tables.get("bhed");
  const post = tables.get("post");
  const weight = os2 && os2.byteLength >= 6 ? os2.getUint16(4) : 400;
  // Figma (CoreText) calls a face italic when any of these three says so. On 1,282 faces checked
  // against FigmaAgent this agreed on 1,281, fsSelection alone on 1,269: Avenir Next "Bold Italic"
  // sets only macStyle, Apple Chancery only italicAngle.
  const italic =
    (os2 !== undefined && os2.byteLength >= 64 && (os2.getUint16(62) & 0x0201) !== 0) || // fsSelection ITALIC or OBLIQUE
    (head !== undefined && head.byteLength >= 46 && (head.getUint16(44) & 0x0002) !== 0) || // macStyle italic
    (post !== undefined && post.byteLength >= 8 && post.getInt32(4) !== 0); // italicAngle

  const base: Face = {
    family,
    style: names.get(17) ?? names.get(2) ?? "Regular",
    postscript: names.get(6) ?? null,
    fullName: names.get(4) ?? null,
    legacyFamily: names.get(1) ?? null,
    legacyStyle: names.get(2) ?? null,
    weight,
    italic,
    variable: false,
  };
  const fvar = tables.get("fvar");
  return fvar ? instanceFaces(fvar, names, base) : [base];
}

function instanceFaces(fvar: DataView, names: Map<number, string>, base: Face): Face[] {
  const axesOffset = fvar.getUint16(4);
  const axisCount = fvar.getUint16(8);
  const axisSize = fvar.getUint16(10);
  const instanceCount = fvar.getUint16(12);
  const instanceSize = fvar.getUint16(14);
  if (axisCount === 0) return [base];
  if (axisSize < 20 || instanceSize < 4 + 4 * axisCount) {
    throw new FontParseError("The font's variation table (fvar) is malformed.");
  }
  const instancesOffset = axesOffset + axisCount * axisSize;
  if (instancesOffset + instanceCount * instanceSize > fvar.byteLength) throw truncated();

  // Coordinates stay raw Fixed 16.16 integers so "is this the default instance" is an exact comparison.
  const tags: string[] = [];
  const defaults: number[] = [];
  for (let a = 0; a < axisCount; a++) {
    tags.push(tagAt(fvar, axesOffset + a * axisSize));
    defaults.push(fvar.getInt32(axesOffset + a * axisSize + 8));
  }
  const wght = tags.indexOf("wght");
  const ital = tags.indexOf("ital");
  const slnt = tags.indexOf("slnt");
  const isDefault = (coords: number[]): boolean => coords.every((c, a) => c === defaults[a]);
  const at = (coords: number[]): Pick<Face, "weight" | "italic"> => ({
    // Figma reports the integer part: SF Pro "Light" at wght 274.315 is listed as 274.
    weight: wght >= 0 ? Math.trunc((coords[wght] ?? 0) / 65536) : base.weight,
    italic: (ital >= 0 && coords[ital] === 65536) || (slnt >= 0 && coords[slnt] !== 0) || base.italic,
  });

  const hasPostScriptId = instanceSize >= 6 + 4 * axisCount;
  const faces: Face[] = [];
  let defaultNamed = false;
  for (let i = 0; i < instanceCount; i++) {
    const record = instancesOffset + i * instanceSize;
    const style = names.get(fvar.getUint16(record));
    // Neither Figma nor the OS can list an instance without a name; skip it rather than invent one.
    if (!style) continue;
    const coords = Array.from({ length: axisCount }, (_, a) => fvar.getInt32(record + 4 + 4 * a));
    const postScriptId = hasPostScriptId ? fvar.getUint16(record + 4 + 4 * axisCount) : NO_NAME;
    const atDefault = isDefault(coords);
    defaultNamed ||= atDefault;
    faces.push({
      family: base.family,
      style,
      postscript: postScriptId === NO_NAME ? null : (names.get(postScriptId) ?? null),
      // Name IDs 1, 2 and 4 describe the default instance only; on any other instance they would alias it.
      fullName: atDefault ? base.fullName : null,
      legacyFamily: atDefault ? base.legacyFamily : null,
      legacyStyle: atDefault ? base.legacyStyle : null,
      ...at(coords),
      variable: true,
    });
  }
  if (!defaultNamed) faces.unshift({ ...base, ...at(defaults), variable: true });
  return faces;
}

const utf16 = new TextDecoder("utf-16be");
const macRoman = new TextDecoder("macintosh");

/**
 * Lower is better. This order reproduced Figma's names on 1,282 of 1,283 faces checked against
 * FigmaAgent; Mac records in other languages and legacy Windows CJK code pages (3/2-6) are not decoded.
 */
function nameRank(platform: number, encoding: number, language: number): number | null {
  if (platform === 3 && (encoding === 0 || encoding === 1 || encoding === 10)) return language === 0x409 ? 0 : 3;
  if (platform === 1 && encoding === 0 && language === 0) return 1;
  if (platform === 0) return 2;
  return null;
}

function readNames(name: DataView): Map<number, string> {
  const count = name.getUint16(2);
  const storage = name.getUint16(4);
  const best = new Map<number, { rank: number; text: string }>();
  for (let i = 0; i < count; i++) {
    const record = 6 + 12 * i;
    const platform = name.getUint16(record);
    const rank = nameRank(platform, name.getUint16(record + 2), name.getUint16(record + 4));
    if (rank === null) continue;
    const nameId = name.getUint16(record + 6);
    const current = best.get(nameId);
    if (current && current.rank <= rank) continue;
    const length = name.getUint16(record + 8);
    const start = storage + name.getUint16(record + 10);
    // One bad record should not sink the font: skip it and let a lower-ranked record supply the name.
    if (start + length > name.byteLength) continue;
    const bytes = new Uint8Array(name.buffer, name.byteOffset + start, length);
    const text = cleanName((platform === 1 ? macRoman : utf16).decode(bytes));
    if (text !== null) best.set(nameId, { rank, text });
  }
  return new Map([...best].map(([id, { text }]) => [id, text]));
}

/** Converted webfonts often carry empty or garbage Windows records next to a valid Mac one. */
function cleanName(raw: string): string | null {
  const text = raw.replace(/\0+$/, "").trim();
  return text === "" || /[\x00-\x1f\x7f]/.test(text) ? null : text;
}
