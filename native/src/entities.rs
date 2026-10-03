//! JSX attribute string decoding, ported from `@babel/parser` 7.29.9 (`jsxReadString` /
//! `jsxReadEntity` in `lib/index.js`).
//!
//! Babel decodes XHTML entities in JSX attribute strings (`name="ho&#109;e"` is the string
//! `home`); oxc keeps the raw text. The JS extractor sees Babel's decoded `StringLiteral`
//! value, so the native extractor decodes the same way before checking the icon shape.
//! (Babel also decodes JSXText, but neither extractor collects text children.)

/// `@babel/parser`'s `entities` map, sorted by name for binary search. Generated from
/// `@babel/parser` 7.29.9 `lib/index.js` (`const entities = { … }`, 253 entries); the jest
/// parity suite re-reads Babel's table and fails if this copy drifts from it.
///
/// No value here is `[a-z0-9_]`, so a decoded named entity always makes a string non-icon-shaped,
/// exactly like the raw `&name;` text would; the table is kept complete anyway so `decode`
/// returns Babel's exact string.
const ENTITIES: &[(&str, char)] = &[
    ("AElig", '\u{C6}'),
    ("Aacute", '\u{C1}'),
    ("Acirc", '\u{C2}'),
    ("Agrave", '\u{C0}'),
    ("Alpha", '\u{391}'),
    ("Aring", '\u{C5}'),
    ("Atilde", '\u{C3}'),
    ("Auml", '\u{C4}'),
    ("Beta", '\u{392}'),
    ("Ccedil", '\u{C7}'),
    ("Chi", '\u{3A7}'),
    ("Dagger", '\u{2021}'),
    ("Delta", '\u{394}'),
    ("ETH", '\u{D0}'),
    ("Eacute", '\u{C9}'),
    ("Ecirc", '\u{CA}'),
    ("Egrave", '\u{C8}'),
    ("Epsilon", '\u{395}'),
    ("Eta", '\u{397}'),
    ("Euml", '\u{CB}'),
    ("Gamma", '\u{393}'),
    ("Iacute", '\u{CD}'),
    ("Icirc", '\u{CE}'),
    ("Igrave", '\u{CC}'),
    ("Iota", '\u{399}'),
    ("Iuml", '\u{CF}'),
    ("Kappa", '\u{39A}'),
    ("Lambda", '\u{39B}'),
    ("Mu", '\u{39C}'),
    ("Ntilde", '\u{D1}'),
    ("Nu", '\u{39D}'),
    ("OElig", '\u{152}'),
    ("Oacute", '\u{D3}'),
    ("Ocirc", '\u{D4}'),
    ("Ograve", '\u{D2}'),
    ("Omega", '\u{3A9}'),
    ("Omicron", '\u{39F}'),
    ("Oslash", '\u{D8}'),
    ("Otilde", '\u{D5}'),
    ("Ouml", '\u{D6}'),
    ("Phi", '\u{3A6}'),
    ("Pi", '\u{3A0}'),
    ("Prime", '\u{2033}'),
    ("Psi", '\u{3A8}'),
    ("Rho", '\u{3A1}'),
    ("Scaron", '\u{160}'),
    ("Sigma", '\u{3A3}'),
    ("THORN", '\u{DE}'),
    ("Tau", '\u{3A4}'),
    ("Theta", '\u{398}'),
    ("Uacute", '\u{DA}'),
    ("Ucirc", '\u{DB}'),
    ("Ugrave", '\u{D9}'),
    ("Upsilon", '\u{3A5}'),
    ("Uuml", '\u{DC}'),
    ("Xi", '\u{39E}'),
    ("Yacute", '\u{DD}'),
    ("Yuml", '\u{178}'),
    ("Zeta", '\u{396}'),
    ("aacute", '\u{E1}'),
    ("acirc", '\u{E2}'),
    ("acute", '\u{B4}'),
    ("aelig", '\u{E6}'),
    ("agrave", '\u{E0}'),
    ("alefsym", '\u{2135}'),
    ("alpha", '\u{3B1}'),
    ("amp", '\u{26}'),
    ("and", '\u{2227}'),
    ("ang", '\u{2220}'),
    ("apos", '\u{27}'),
    ("aring", '\u{E5}'),
    ("asymp", '\u{2248}'),
    ("atilde", '\u{E3}'),
    ("auml", '\u{E4}'),
    ("bdquo", '\u{201E}'),
    ("beta", '\u{3B2}'),
    ("brvbar", '\u{A6}'),
    ("bull", '\u{2022}'),
    ("cap", '\u{2229}'),
    ("ccedil", '\u{E7}'),
    ("cedil", '\u{B8}'),
    ("cent", '\u{A2}'),
    ("chi", '\u{3C7}'),
    ("circ", '\u{2C6}'),
    ("clubs", '\u{2663}'),
    ("cong", '\u{2245}'),
    ("copy", '\u{A9}'),
    ("crarr", '\u{21B5}'),
    ("cup", '\u{222A}'),
    ("curren", '\u{A4}'),
    ("dArr", '\u{21D3}'),
    ("dagger", '\u{2020}'),
    ("darr", '\u{2193}'),
    ("deg", '\u{B0}'),
    ("delta", '\u{3B4}'),
    ("diams", '\u{2666}'),
    ("divide", '\u{F7}'),
    ("eacute", '\u{E9}'),
    ("ecirc", '\u{EA}'),
    ("egrave", '\u{E8}'),
    ("empty", '\u{2205}'),
    ("emsp", '\u{2003}'),
    ("ensp", '\u{2002}'),
    ("epsilon", '\u{3B5}'),
    ("equiv", '\u{2261}'),
    ("eta", '\u{3B7}'),
    ("eth", '\u{F0}'),
    ("euml", '\u{EB}'),
    ("euro", '\u{20AC}'),
    ("exist", '\u{2203}'),
    ("fnof", '\u{192}'),
    ("forall", '\u{2200}'),
    ("frac12", '\u{BD}'),
    ("frac14", '\u{BC}'),
    ("frac34", '\u{BE}'),
    ("frasl", '\u{2044}'),
    ("gamma", '\u{3B3}'),
    ("ge", '\u{2265}'),
    ("gt", '\u{3E}'),
    ("hArr", '\u{21D4}'),
    ("harr", '\u{2194}'),
    ("hearts", '\u{2665}'),
    ("hellip", '\u{2026}'),
    ("iacute", '\u{ED}'),
    ("icirc", '\u{EE}'),
    ("iexcl", '\u{A1}'),
    ("igrave", '\u{EC}'),
    ("image", '\u{2111}'),
    ("infin", '\u{221E}'),
    ("int", '\u{222B}'),
    ("iota", '\u{3B9}'),
    ("iquest", '\u{BF}'),
    ("isin", '\u{2208}'),
    ("iuml", '\u{EF}'),
    ("kappa", '\u{3BA}'),
    ("lArr", '\u{21D0}'),
    ("lambda", '\u{3BB}'),
    ("lang", '\u{2329}'),
    ("laquo", '\u{AB}'),
    ("larr", '\u{2190}'),
    ("lceil", '\u{2308}'),
    ("ldquo", '\u{201C}'),
    ("le", '\u{2264}'),
    ("lfloor", '\u{230A}'),
    ("lowast", '\u{2217}'),
    ("loz", '\u{25CA}'),
    ("lrm", '\u{200E}'),
    ("lsaquo", '\u{2039}'),
    ("lsquo", '\u{2018}'),
    ("lt", '\u{3C}'),
    ("macr", '\u{AF}'),
    ("mdash", '\u{2014}'),
    ("micro", '\u{B5}'),
    ("middot", '\u{B7}'),
    ("minus", '\u{2212}'),
    ("mu", '\u{3BC}'),
    ("nabla", '\u{2207}'),
    ("nbsp", '\u{A0}'),
    ("ndash", '\u{2013}'),
    ("ne", '\u{2260}'),
    ("ni", '\u{220B}'),
    ("not", '\u{AC}'),
    ("notin", '\u{2209}'),
    ("nsub", '\u{2284}'),
    ("ntilde", '\u{F1}'),
    ("nu", '\u{3BD}'),
    ("oacute", '\u{F3}'),
    ("ocirc", '\u{F4}'),
    ("oelig", '\u{153}'),
    ("ograve", '\u{F2}'),
    ("oline", '\u{203E}'),
    ("omega", '\u{3C9}'),
    ("omicron", '\u{3BF}'),
    ("oplus", '\u{2295}'),
    ("or", '\u{2228}'),
    ("ordf", '\u{AA}'),
    ("ordm", '\u{BA}'),
    ("oslash", '\u{F8}'),
    ("otilde", '\u{F5}'),
    ("otimes", '\u{2297}'),
    ("ouml", '\u{F6}'),
    ("para", '\u{B6}'),
    ("part", '\u{2202}'),
    ("permil", '\u{2030}'),
    ("perp", '\u{22A5}'),
    ("phi", '\u{3C6}'),
    ("pi", '\u{3C0}'),
    ("piv", '\u{3D6}'),
    ("plusmn", '\u{B1}'),
    ("pound", '\u{A3}'),
    ("prime", '\u{2032}'),
    ("prod", '\u{220F}'),
    ("prop", '\u{221D}'),
    ("psi", '\u{3C8}'),
    ("quot", '\u{22}'),
    ("rArr", '\u{21D2}'),
    ("radic", '\u{221A}'),
    ("rang", '\u{232A}'),
    ("raquo", '\u{BB}'),
    ("rarr", '\u{2192}'),
    ("rceil", '\u{2309}'),
    ("rdquo", '\u{201D}'),
    ("real", '\u{211C}'),
    ("reg", '\u{AE}'),
    ("rfloor", '\u{230B}'),
    ("rho", '\u{3C1}'),
    ("rlm", '\u{200F}'),
    ("rsaquo", '\u{203A}'),
    ("rsquo", '\u{2019}'),
    ("sbquo", '\u{201A}'),
    ("scaron", '\u{161}'),
    ("sdot", '\u{22C5}'),
    ("sect", '\u{A7}'),
    ("shy", '\u{AD}'),
    ("sigma", '\u{3C3}'),
    ("sigmaf", '\u{3C2}'),
    ("sim", '\u{223C}'),
    ("spades", '\u{2660}'),
    ("sub", '\u{2282}'),
    ("sube", '\u{2286}'),
    ("sum", '\u{2211}'),
    ("sup", '\u{2283}'),
    ("sup1", '\u{B9}'),
    ("sup2", '\u{B2}'),
    ("sup3", '\u{B3}'),
    ("supe", '\u{2287}'),
    ("szlig", '\u{DF}'),
    ("tau", '\u{3C4}'),
    ("there4", '\u{2234}'),
    ("theta", '\u{3B8}'),
    ("thetasym", '\u{3D1}'),
    ("thinsp", '\u{2009}'),
    ("thorn", '\u{FE}'),
    ("tilde", '\u{2DC}'),
    ("times", '\u{D7}'),
    ("trade", '\u{2122}'),
    ("uArr", '\u{21D1}'),
    ("uacute", '\u{FA}'),
    ("uarr", '\u{2191}'),
    ("ucirc", '\u{FB}'),
    ("ugrave", '\u{F9}'),
    ("uml", '\u{A8}'),
    ("upsih", '\u{3D2}'),
    ("upsilon", '\u{3C5}'),
    ("uuml", '\u{FC}'),
    ("weierp", '\u{2118}'),
    ("xi", '\u{3BE}'),
    ("yacute", '\u{FD}'),
    ("yen", '\u{A5}'),
    ("yuml", '\u{FF}'),
    ("zeta", '\u{3B6}'),
    ("zwj", '\u{200D}'),
    ("zwnj", '\u{200C}'),
];

fn named_entity(name: &str) -> Option<char> {
    ENTITIES
        .binary_search_by(|(k, _)| (*k).cmp(name))
        .ok()
        .map(|i| ENTITIES[i].1)
}

/// Babel `readInt(radix, undefined, false, "bail")`: greedy digits of `radix` (10 or 16), no
/// separators. `None` when there is no digit. Saturates: every value above `0x10FFFF` is
/// rejected the same way afterwards.
fn read_int(bytes: &[u8], pos: &mut usize, radix: u32) -> Option<u64> {
    let start = *pos;
    let mut total: u64 = 0;
    while let Some(d) = bytes.get(*pos).and_then(|&b| char::from(b).to_digit(radix)) {
        total = total
            .saturating_mul(u64::from(radix))
            .saturating_add(u64::from(d));
        *pos += 1;
    }
    (*pos > start).then_some(total)
}

/// The value Babel gives a JSX attribute string whose raw text (between the quotes) is `raw`.
///
/// `&#NNN;` / `&#xHHH;` (lowercase `x` only, hex digits either case) become that code point,
/// `&name;` (at most 10 characters before the `;`) becomes the entity, anything else keeps its
/// `&`. A lone surrogate (Babel builds a lone UTF-16 unit) becomes U+FFFD here; neither is
/// icon-shaped. `None` when Babel throws: `String.fromCodePoint` raises a `RangeError` for a
/// numeric entity above U+10FFFF, which makes the JS extractor fall back to the regex.
/// Newlines are kept as written (Babel `jsxReadNewLine(false)` does not normalise CRLF here).
pub fn decode_jsx_attribute(raw: &str) -> Option<String> {
    if !raw.contains('&') {
        return Some(raw.to_string());
    }
    let bytes = raw.as_bytes();
    let mut out = String::with_capacity(raw.len());
    let (mut pos, mut chunk_start) = (0usize, 0usize);
    while pos < bytes.len() {
        if bytes[pos] != b'&' {
            pos += 1;
            continue;
        }
        out.push_str(&raw[chunk_start..pos]);
        let start = pos + 1;
        pos = start;
        let mut decoded = None;
        if bytes.get(pos) == Some(&b'#') {
            pos += 1;
            let radix = if bytes.get(pos) == Some(&b'x') {
                pos += 1;
                16
            } else {
                10
            };
            if let Some(cp) = read_int(bytes, &mut pos, radix) {
                if bytes.get(pos) == Some(&b';') {
                    pos += 1;
                    if cp > 0x10FFFF {
                        return None;
                    }
                    // `cp <= 0x10FFFF`, so the cast is lossless
                    decoded = Some(char::from_u32(cp as u32).unwrap_or('\u{FFFD}'));
                }
            }
        } else if let Some(semi) = bytes[start..].iter().take(10).position(|&b| b == b';') {
            // Babel scans at most 10 code units for the `;`; every entity name is ASCII, so a
            // byte window finds the same `;` whenever the slice can name an entity.
            let entity = raw.get(start..start + semi).and_then(named_entity);
            if let Some(c) = entity {
                pos = start + semi + 1;
                decoded = Some(c);
            }
        }
        match decoded {
            Some(c) => out.push(c),
            None => {
                pos = start;
                out.push('&');
            }
        }
        chunk_start = pos;
    }
    out.push_str(&raw[chunk_start..]);
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(raw: &str) -> Option<String> {
        decode_jsx_attribute(raw)
    }

    #[test]
    fn numeric_entities() {
        assert_eq!(d("ho&#109;e").as_deref(), Some("home"));
        assert_eq!(d("ho&#x6d;e").as_deref(), Some("home"));
        assert_eq!(d("ho&#x6D;e").as_deref(), Some("home"));
        assert_eq!(d("ho&#000109;e").as_deref(), Some("home"));
        assert_eq!(d("arrow&#95;back").as_deref(), Some("arrow_back"));
        assert_eq!(d("&#0;").as_deref(), Some("\0"));
        assert_eq!(d("&#x10FFFF;").as_deref(), Some("\u{10FFFF}"));
        assert_eq!(d("&#xD800;").as_deref(), Some("\u{FFFD}"));
    }

    #[test]
    fn invalid_numeric_entities_keep_the_ampersand() {
        for raw in [
            "ho&#109e", "&#X6d;", "&#;", "&#x;", "&#1_09;", "&#x6g;", "&#",
        ] {
            assert_eq!(d(raw).as_deref(), Some(raw), "{raw}");
        }
    }

    #[test]
    fn numeric_entities_beyond_unicode_make_babel_throw() {
        assert_eq!(d("&#x110000;"), None);
        assert_eq!(d("&#99999999;"), None);
        assert_eq!(d(&format!("&#{};", "9".repeat(40))), None);
        // without the `;` Babel never calls fromCodePoint
        assert_eq!(d("&#99999999").as_deref(), Some("&#99999999"));
    }

    #[test]
    fn named_entities() {
        assert_eq!(
            d("a&amp;b&lt;c&gt;&quot;&apos;&nbsp;").as_deref(),
            Some("a&b<c>\"'\u{A0}")
        );
        assert_eq!(
            d("&hearts;&diams;&AElig;").as_deref(),
            Some("\u{2665}\u{2666}\u{C6}")
        );
        // unknown, prototype keys, missing `;`, name longer than 10
        for raw in [
            "ho&foo;me",
            "&__proto__;",
            "&constructor;",
            "&amp",
            "home&",
            "&abcdefghijk;",
            "&;",
        ] {
            assert_eq!(d(raw).as_deref(), Some(raw), "{raw}");
        }
        // a failed named lookup resumes right after the `&`
        assert_eq!(d("&a&#109;").as_deref(), Some("&am"));
        assert_eq!(d("&&amp;").as_deref(), Some("&&"));
    }

    #[test]
    fn non_ascii_and_newlines_are_kept() {
        assert_eq!(d("한&#109;글\r\n").as_deref(), Some("한m글\r\n"));
        assert_eq!(d("&한;").as_deref(), Some("&한;"));
    }

    #[test]
    fn table_is_sorted_and_unique() {
        assert_eq!(ENTITIES.len(), 253);
        assert!(ENTITIES.windows(2).all(|w| w[0].0 < w[1].0));
        assert!(ENTITIES
            .iter()
            .all(|(_, c)| !(c.is_ascii_lowercase() || c.is_ascii_digit() || *c == '_')));
    }
}
