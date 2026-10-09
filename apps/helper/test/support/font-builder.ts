// Builds small but structurally valid sfnt files in memory so tests need no binary fixtures.

export type FvarSpec = {
  axes: { tag: string; min: number; def: number; max: number }[];
  /** `postscript` set on any instance makes every instance record carry a postScriptNameID. */
  instances: { subfamily: string; coords: number[]; postscript?: string }[];
};

export type FontSpec = {
  /** Windows (3,1,0x409) name records by name ID. */
  names: Record<number, string>;
  /** Mac (1,0,0) records, for fallback tests. */
  macNames?: Record<number, string>;
  /** "ttf" writes 0x00010000 + glyf/loca; "otf" writes OTTO + a CFF table. */
  flavor?: "ttf" | "otf";
  weight?: number;
  width?: number;
  italic?: boolean;
  fvar?: FvarSpec;
  /** Omit tables to produce invalid fonts. */
  omitTables?: string[];
};

/** One raw name record. Platform 1 text is written as Mac Roman, every other platform as UTF-16BE. */
export type NameRecordSpec = { platform: number; encoding: number; language: number; nameId: number; text: string };

export function buildFont(spec: FontSpec): Uint8Array {
  const font = layout([{ version: sfntVersion(spec), tables: fontTables(spec) }], false);
  setCheckSumAdjustment(font);
  return font;
}

export function buildCollection(specs: FontSpec[]): Uint8Array {
  return layout(
    specs.map((spec) => ({ version: sfntVersion(spec), tables: fontTables(spec) })),
    true,
  );
}

/** A 'name' table holding exactly `records`, for tests that need platforms or languages FontSpec cannot express. */
export function nameTable(records: NameRecordSpec[]): Uint8Array {
  return encodeNameTable(
    records.map((r) => ({ ...r, bytes: r.platform === 1 ? encodeMacRoman(r.text) : encodeUtf16(r.text) })),
  );
}

/** Rebuilds a single (non-collection) font with `tag` replaced, added, or removed when `data` is null. */
export function withTable(font: Uint8Array, tag: string, data: Uint8Array | null): Uint8Array {
  const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
  if (readTag(view, 0) === "ttcf") throw new Error("withTable rebuilds single fonts, not collections");
  const tables: Table[] = readDirectory(view, 0)
    .filter((t) => t.tag !== tag)
    .map((t) => ({ tag: t.tag, data: font.slice(t.offset, t.offset + t.length) }));
  if (data) tables.push({ tag, data });
  const rebuilt = layout([{ version: view.getUint32(0), tables }], false);
  setCheckSumAdjustment(rebuilt);
  return rebuilt;
}

/** Where table `tag` of collection member `member` lives, as absolute file offsets; null when absent. */
export function findTable(font: Uint8Array, tag: string, member = 0): { offset: number; length: number } | null {
  const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
  const directory = readTag(view, 0) === "ttcf" ? view.getUint32(12 + 4 * member) : 0;
  const record = readDirectory(view, directory).find((t) => t.tag === tag);
  return record ? { offset: record.offset, length: record.length } : null;
}

type Table = { tag: string; data: Uint8Array };

class ByteWriter {
  private readonly out: number[] = [];

  get length(): number {
    return this.out.length;
  }

  u8(value: number): this {
    this.out.push(value & 0xff);
    return this;
  }

  /** Also writes int16: the two's complement low 16 bits are the same. */
  u16(value: number): this {
    return this.u8(value >>> 8).u8(value);
  }

  u32(value: number): this {
    return this.u16(value >>> 16).u16(value & 0xffff);
  }

  fixed(value: number): this {
    return this.u32(Math.round(value * 65536) >>> 0);
  }

  tag(tag: string): this {
    if (!/^[\x20-\x7e]{4}$/.test(tag)) throw new Error(`table tag must be 4 printable ASCII characters: ${JSON.stringify(tag)}`);
    for (let i = 0; i < 4; i++) this.u8(tag.charCodeAt(i));
    return this;
  }

  bytes(data: Uint8Array): this {
    for (const b of data) this.out.push(b);
    return this;
  }

  zeros(count: number): this {
    for (let i = 0; i < count; i++) this.out.push(0);
    return this;
  }

  pad4(): this {
    return this.zeros((4 - (this.out.length % 4)) % 4);
  }

  toBytes(): Uint8Array {
    return Uint8Array.from(this.out);
  }
}

const UNITS_PER_EM = 1000;

function sfntVersion(spec: FontSpec): number {
  return spec.flavor === "otf" ? 0x4f54544f /* OTTO */ : 0x00010000;
}

function fontTables(spec: FontSpec): Table[] {
  const flavor = spec.flavor ?? "ttf";
  const weight = spec.weight ?? 400;
  const italic = spec.italic ?? false;
  const windowsNames = new Map(Object.entries(spec.names).map(([id, text]) => [Number(id), text]));

  const tables: Table[] = [
    { tag: "head", data: headTable(weight, italic) },
    { tag: "hhea", data: hheaTable() },
    { tag: "maxp", data: maxpTable(flavor) },
    { tag: "OS/2", data: os2Table(weight, spec.width ?? 5, italic) },
    { tag: "hmtx", data: new ByteWriter().u16(500).u16(0).toBytes() },
    { tag: "cmap", data: cmapTable() },
    { tag: "post", data: postTable(italic) },
  ];
  if (flavor === "ttf") {
    // One empty .notdef glyph: loca [0, 0]. The glyf bytes are a placeholder nothing reads.
    tables.push({ tag: "loca", data: new ByteWriter().u16(0).u16(0).toBytes() });
    tables.push({ tag: "glyf", data: new Uint8Array(4) });
  } else {
    // CFF header plus empty Name, Top DICT, String and Global Subr INDEXes.
    tables.push({ tag: "CFF ", data: Uint8Array.of(1, 0, 4, 1, 0, 0, 0, 0, 0, 0, 0, 0) });
  }
  if (spec.fvar) tables.push({ tag: "fvar", data: fvarTable(spec.fvar, windowsNames) });

  const records: (NameRecordSpec & { bytes: Uint8Array })[] = [];
  for (const [nameId, text] of windowsNames) {
    records.push({ platform: 3, encoding: 1, language: 0x409, nameId, text, bytes: encodeUtf16(text) });
  }
  for (const [id, text] of Object.entries(spec.macNames ?? {})) {
    records.push({ platform: 1, encoding: 0, language: 0, nameId: Number(id), text, bytes: encodeMacRoman(text) });
  }
  tables.push({ tag: "name", data: encodeNameTable(records) });

  const omit = new Set(spec.omitTables ?? []);
  return tables.filter((t) => !omit.has(t.tag));
}

function headTable(weight: number, italic: boolean): Uint8Array {
  return new ByteWriter()
    .u32(0x00010000) // version
    .u32(0x00010000) // fontRevision
    .u32(0) // checkSumAdjustment, filled in once the whole font is laid out
    .u32(0x5f0f3cf5) // magicNumber
    .u16(0) // flags
    .u16(UNITS_PER_EM)
    .zeros(16) // created, modified
    .zeros(4) // xMin, yMin
    .u16(UNITS_PER_EM) // xMax
    .u16(UNITS_PER_EM) // yMax
    .u16((weight >= 700 ? 1 : 0) | (italic ? 2 : 0)) // macStyle @44: bit 0 bold, bit 1 italic
    .u16(8) // lowestRecPPEM
    .u16(2) // fontDirectionHint
    .u16(0) // indexToLocFormat: short
    .u16(0) // glyphDataFormat
    .toBytes();
}

function hheaTable(): Uint8Array {
  return new ByteWriter()
    .u32(0x00010000)
    .u16(800) // ascender
    .u16(-200) // descender
    .u16(0) // lineGap
    .u16(500) // advanceWidthMax
    .zeros(4) // minLeftSideBearing, minRightSideBearing
    .u16(500) // xMaxExtent
    .u16(1) // caretSlopeRise
    .zeros(4) // caretSlopeRun, caretOffset
    .zeros(8) // reserved
    .u16(0) // metricDataFormat
    .u16(1) // numberOfHMetrics
    .toBytes();
}

function maxpTable(flavor: "ttf" | "otf"): Uint8Array {
  if (flavor === "otf") return new ByteWriter().u32(0x00005000).u16(1).toBytes();
  // Version 1.0: numGlyphs then 13 limits, of which only maxZones must be non-zero.
  return new ByteWriter().u32(0x00010000).u16(1).zeros(8).u16(2).zeros(16).toBytes();
}

function os2Table(weight: number, width: number, italic: boolean): Uint8Array {
  // Bit 0 ITALIC, bit 5 BOLD, bit 6 REGULAR (only when neither of the others is set).
  const fsSelection = (italic ? 0x01 : 0) | (weight >= 700 ? 0x20 : 0) || 0x40;
  const w = new ByteWriter()
    .u16(4) // version
    .u16(500) // xAvgCharWidth
    .u16(weight) // usWeightClass @4
    .u16(width) // usWidthClass @6
    .u16(0) // fsType
    .zeros(20) // subscript, superscript and strikeout metrics
    .u16(0) // sFamilyClass
    .zeros(10) // panose
    .zeros(16) // ulUnicodeRange1-4
    .tag("NONE") // achVendID
    .u16(fsSelection) // fsSelection @62
    .u16(0x20) // usFirstCharIndex
    .u16(0x20) // usLastCharIndex
    .u16(800) // sTypoAscender
    .u16(-200) // sTypoDescender
    .u16(0) // sTypoLineGap
    .u16(800) // usWinAscent
    .u16(200) // usWinDescent
    .u32(1) // ulCodePageRange1: Latin 1
    .u32(0) // ulCodePageRange2
    .u16(500) // sxHeight
    .u16(700) // sCapHeight
    .u16(0) // usDefaultChar
    .u16(0x20) // usBreakChar
    .u16(1); // usMaxContext
  if (w.length !== 96) throw new Error(`OS/2 v4 must be 96 bytes, wrote ${w.length}`);
  return w.toBytes();
}

/** A (3,1) format 4 subtable with only the mandatory final 0xFFFF segment. */
function cmapTable(): Uint8Array {
  return new ByteWriter()
    .u16(0) // version
    .u16(1) // numTables
    .u16(3) // encoding record: platform
    .u16(1) // encoding
    .u32(12) // subtable offset
    .u16(4) // format
    .u16(24) // length
    .u16(0) // language
    .u16(2) // segCountX2
    .u16(2) // searchRange
    .u16(0) // entrySelector
    .u16(0) // rangeShift
    .u16(0xffff) // endCode[0]
    .u16(0) // reservedPad
    .u16(0xffff) // startCode[0]
    .u16(1) // idDelta[0]
    .u16(0) // idRangeOffset[0]
    .toBytes();
}

function postTable(italic: boolean): Uint8Array {
  return new ByteWriter()
    .u32(0x00030000)
    .fixed(italic ? -12 : 0) // italicAngle
    .u16(-100) // underlinePosition
    .u16(50) // underlineThickness
    .u32(0) // isFixedPitch
    .zeros(16) // min/max memory hints
    .toBytes();
}

/** Adds the axis and instance strings to `names` under fresh IDs >= 256. */
function fvarTable(fvar: FvarSpec, names: Map<number, string>): Uint8Array {
  let nextId = Math.max(255, ...names.keys()) + 1;
  const allocated = new Map<string, number>();
  const nameId = (text: string): number => {
    let id = allocated.get(text);
    if (id === undefined) {
      id = nextId++;
      allocated.set(text, id);
      names.set(id, text);
    }
    return id;
  };

  const axisCount = fvar.axes.length;
  const withPostScript = fvar.instances.some((i) => i.postscript !== undefined);
  const instanceSize = 4 + 4 * axisCount + (withPostScript ? 2 : 0);
  const w = new ByteWriter()
    .u16(1) // majorVersion
    .u16(0) // minorVersion
    .u16(16) // axesArrayOffset
    .u16(2) // reserved
    .u16(axisCount)
    .u16(20) // axisSize
    .u16(fvar.instances.length)
    .u16(instanceSize);
  for (const axis of fvar.axes) {
    w.tag(axis.tag).fixed(axis.min).fixed(axis.def).fixed(axis.max).u16(0).u16(nameId(axis.tag));
  }
  for (const instance of fvar.instances) {
    if (instance.coords.length !== axisCount) {
      throw new Error(`instance ${instance.subfamily} has ${instance.coords.length} coords for ${axisCount} axes`);
    }
    w.u16(nameId(instance.subfamily)).u16(0);
    for (const c of instance.coords) w.fixed(c);
    if (withPostScript) w.u16(instance.postscript === undefined ? 0xffff : nameId(instance.postscript));
  }
  return w.toBytes();
}

function encodeNameTable(records: (NameRecordSpec & { bytes: Uint8Array })[]): Uint8Array {
  const sorted = [...records].sort(
    (a, b) => a.platform - b.platform || a.encoding - b.encoding || a.language - b.language || a.nameId - b.nameId,
  );
  const w = new ByteWriter().u16(0).u16(sorted.length).u16(6 + 12 * sorted.length);
  let stringOffset = 0;
  for (const r of sorted) {
    w.u16(r.platform).u16(r.encoding).u16(r.language).u16(r.nameId).u16(r.bytes.length).u16(stringOffset);
    stringOffset += r.bytes.length;
  }
  for (const r of sorted) w.bytes(r.bytes);
  return w.toBytes();
}

function encodeUtf16(text: string): Uint8Array {
  const w = new ByteWriter();
  for (let i = 0; i < text.length; i++) w.u16(text.charCodeAt(i));
  return w.toBytes();
}

const MAC_ROMAN = (() => {
  // Inverting the decoder keeps the builder exactly consistent with what the parser decodes.
  const decoder = new TextDecoder("macintosh");
  const map = new Map<string, number>();
  for (let b = 0; b < 256; b++) map.set(decoder.decode(Uint8Array.of(b)), b);
  return map;
})();

function encodeMacRoman(text: string): Uint8Array {
  const w = new ByteWriter();
  for (const ch of text) {
    const b = MAC_ROMAN.get(ch);
    if (b === undefined) throw new Error(`${JSON.stringify(ch)} has no Mac Roman encoding`);
    w.u8(b);
  }
  return w.toBytes();
}

function checksum(data: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    const word = ((data[i] ?? 0) << 24) | ((data[i + 1] ?? 0) << 16) | ((data[i + 2] ?? 0) << 8) | (data[i + 3] ?? 0);
    sum = (sum + (word >>> 0)) >>> 0;
  }
  return sum;
}

/**
 * Writes one table directory per member, then each distinct table once. Members of a collection
 * share identical tables, as real TTCs do, and every offset is from the start of the file.
 */
function layout(members: { version: number; tables: Table[] }[], collection: boolean): Uint8Array {
  const sortedMembers = members.map((m) => [...m.tables].sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0)));
  for (const tables of sortedMembers) {
    const tags = tables.map((t) => t.tag);
    if (new Set(tags).size !== tags.length) throw new Error(`duplicate table tags: ${tags.join(", ")}`);
  }

  const headerSize = collection ? 12 + 4 * members.length : 0;
  const directoryOffsets: number[] = [];
  let cursor = headerSize;
  for (const tables of sortedMembers) {
    directoryOffsets.push(cursor);
    cursor += 12 + 16 * tables.length;
  }

  const placed = new Map<string, number>();
  const data = new ByteWriter();
  const dataStart = cursor;
  const offsetOf = (table: Table): number => {
    const key = `${table.tag}:${Buffer.from(table.data).toString("base64")}`;
    let offset = placed.get(key);
    if (offset === undefined) {
      offset = dataStart + data.length;
      placed.set(key, offset);
      data.bytes(table.data).pad4();
    }
    return offset;
  };

  const out = new ByteWriter();
  if (collection) {
    out.tag("ttcf").u16(1).u16(0).u32(members.length);
    for (const offset of directoryOffsets) out.u32(offset);
  }
  sortedMembers.forEach((tables, i) => {
    const n = tables.length;
    const log2 = n > 0 ? Math.floor(Math.log2(n)) : 0;
    const searchRange = n > 0 ? 2 ** log2 * 16 : 0;
    out.u32(members[i]?.version ?? 0x00010000).u16(n).u16(searchRange).u16(log2).u16(n * 16 - searchRange);
    for (const table of tables) {
      out.tag(table.tag).u32(checksum(table.data)).u32(offsetOf(table)).u32(table.data.length);
    }
  });
  out.bytes(data.toBytes());
  return out.toBytes();
}

/** Only for single fonts: in a collection the adjustment would cover the shared file, which no tool checks. */
function setCheckSumAdjustment(font: Uint8Array): void {
  const head = findTable(font, "head");
  if (!head) return;
  const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
  view.setUint32(head.offset + 8, 0);
  view.setUint32(head.offset + 8, (0xb1b0afba - checksum(font)) >>> 0);
}

function readTag(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

function readDirectory(view: DataView, offset: number): { tag: string; offset: number; length: number }[] {
  const count = view.getUint16(offset + 4);
  return Array.from({ length: count }, (_, i) => {
    const r = offset + 12 + 16 * i;
    return { tag: readTag(view, r), offset: view.getUint32(r + 8), length: view.getUint32(r + 12) };
  });
}
