/**
 * Runtime patches needed only when running as a pkg-compiled binary, where
 * the bundled Node build lacks full ICU data. Keep every pkg-only shim here
 * so they're easy to find in one place instead of scattered across files.
 */

// windows-1252, bytes 0x80-0x9F -> code point (0xA0-0xFF is a direct
// passthrough to U+00A0-U+00FF, same as Latin-1). Standard/public codec
// table (WHATWG Encoding Standard), not app-specific data.
const WIN1252_HIGH = [
  0x20AC, 0x0081, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021,
  0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008D, 0x017D, 0x008F,
  0x0090, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014,
  0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x009D, 0x017E, 0x0178,
];

// Legacy labels that the WHATWG Encoding Standard maps to the windows-1252
// codec (this is what a full-ICU TextDecoder would also do - this isn't a
// looser stand-in, it's the same spec'd behavior implemented by hand).
const WIN1252_ALIASES = new Set([
  "ascii", "us-ascii", "ansi_x3.4-1968", "ansi_x3.4-1986", "cp819",
  "csisolatin1", "ibm819", "iso-8859-1", "iso-ir-100", "iso8859-1",
  "iso88591", "l1", "latin1", "windows-1252", "x-cp1252",
]);

function decodeWindows1252(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    // 0x00-0x7F and 0xA0-0xFF map straight to the same-numbered code point
    // (plain ASCII, then Latin-1 supplement) - only 0x80-0x9F need the table.
    out += String.fromCharCode(b >= 0x80 && b < 0xA0 ? WIN1252_HIGH[b - 0x80] : b);
  }
  return out;
}

// Wraps the global TextDecoder so windows-1252-family labels are decoded by
// hand, and every other label (utf-8, utf-16, etc.) still goes through the
// real native decoder unchanged.
function installTextDecoderPolyfill() {
  const NativeTextDecoder = globalThis.TextDecoder;

  class PatchedTextDecoder {
    constructor(label = "utf-8", options) {
      const normalized = String(label).trim().toLowerCase();
      if (WIN1252_ALIASES.has(normalized)) {
        this._legacy = true;
        this._encoding = "windows-1252";
      } else {
        this._native = new NativeTextDecoder(label, options);
      }
    }

    get encoding() {
      return this._legacy ? this._encoding : this._native.encoding;
    }

    decode(input) {
      if (!this._legacy) return this._native.decode(input);
      const bytes = input instanceof Uint8Array
        ? input
        : new Uint8Array(input && input.buffer ? input.buffer : input || []);
      return decodeWindows1252(bytes);
    }
  }

  globalThis.TextDecoder = PatchedTextDecoder;
}

module.exports = { installTextDecoderPolyfill };
