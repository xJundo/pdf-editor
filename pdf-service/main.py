"""PDF processing service.

Internal-only service (never exposed publicly). Reads and writes PDF files
on the shared /data/files volume; the Next.js app passes file paths relative
to FILES_ROOT, never raw file contents.
"""

import base64
import binascii
import functools
import io
import os
import re
from collections import defaultdict
from pathlib import Path
from typing import Annotated, Literal

import pymupdf
from fastapi import FastAPI, HTTPException, Response
from fontTools import agl
from fontTools.cffLib import CFFFontSet
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.boundsPen import BoundsPen
from fontTools.ttLib import TTFont, newTable
from fontTools.ttLib.tables._c_m_a_p import CmapSubtable
from pydantic import BaseModel, Field

FILES_ROOT = Path(os.environ.get("FILES_ROOT", "/data/files")).resolve()

app = FastAPI(title="pdf-service", docs_url=None, redoc_url=None)


def resolve_file(relative_path: str) -> Path:
    """Resolve a client-supplied relative path, refusing escapes from FILES_ROOT."""
    path = (FILES_ROOT / relative_path).resolve()
    if not path.is_relative_to(FILES_ROOT):
        raise HTTPException(status_code=400, detail="invalid path")
    if not path.is_file():
        raise HTTPException(status_code=404, detail="file not found")
    return path


def resolve_target(relative_path: str) -> Path:
    """Resolve an output path: must stay inside FILES_ROOT, parent must exist."""
    path = (FILES_ROOT / relative_path).resolve()
    if not path.is_relative_to(FILES_ROOT):
        raise HTTPException(status_code=400, detail="invalid path")
    if not path.parent.is_dir():
        raise HTTPException(status_code=400, detail="target directory does not exist")
    if path.exists():
        raise HTTPException(status_code=409, detail="target already exists")
    return path


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "pymupdf": pymupdf.__version__}


@app.get("/documents/info")
def document_info(path: str) -> dict:
    """Basic sanity endpoint: open a PDF and return page count and metadata."""
    file = resolve_file(path)
    try:
        with pymupdf.open(file) as doc:
            if not doc.is_pdf:
                raise HTTPException(status_code=422, detail="not a PDF")
            return {
                "pageCount": doc.page_count,
                "encrypted": doc.needs_pass,
                "metadata": doc.metadata,
            }
    except pymupdf.FileDataError as exc:
        raise HTTPException(status_code=422, detail=f"cannot open PDF: {exc}") from exc


# Span flag bits documented by PyMuPDF (TextPage.extractDICT).
_FLAG_ITALIC = 1 << 1
_FLAG_BOLD = 1 << 4

# Images covering at least this fraction of the page are treated as flattened
# backgrounds/templates: shown, but not interactive (so text on top stays
# editable and empty areas don't select the whole-page image).
_BACKGROUND_COVERAGE = 0.9


def _color_to_hex(color: int) -> str:
    return f"#{color:06x}"


def _font_has_unicode_cmap(buffer: bytes) -> bool:
    """True if a font program exposes a real unicode cmap."""
    try:
        tt = TTFont(io.BytesIO(buffer), fontNumber=0, lazy=True)
    except Exception:
        return False
    try:
        if "cmap" not in tt:
            return False
        return any(table.isUnicode() and table.cmap for table in tt["cmap"].tables)
    finally:
        tt.close()


_HEX_TOKEN = r"<([0-9A-Fa-f]+)>"


def _utf16be_codepoint(hex_digits: str) -> int | None:
    """Sole code point of a ToUnicode destination, or None if it is not one.

    Multi-character destinations are ligatures: <00AA> <00660069> says "glyph
    0xAA displays as fi". Reversing that to f -> 0xAA is wrong — it would make
    every f render as "fi", so "file" comes out "fiile". A ligature has no
    single-character inverse and must be dropped, not truncated.
    """
    try:
        text = bytes.fromhex(hex_digits).decode("utf-16-be")
    except (ValueError, UnicodeDecodeError):
        return None
    return ord(text) if len(text) == 1 else None


def parse_tounicode(cmap_source: str) -> dict[int, int]:
    """Parse a ToUnicode CMap into {unicode code point -> character code}.

    Covers the three constructs producers emit: bfchar (<src> <dst>), and
    bfrange in both its contiguous form (<lo> <hi> <dst_base>) and its array
    form (<lo> <hi> [<dst> <dst> ...]). First writer wins, so the lowest code
    backing a given character is the one used.
    """
    mapping: dict[int, int] = {}
    for block in re.findall(r"beginbfchar(.*?)endbfchar", cmap_source, re.S):
        for src, dst in re.findall(rf"{_HEX_TOKEN}\s+{_HEX_TOKEN}", block):
            code_point = _utf16be_codepoint(dst)
            if code_point is not None:
                mapping.setdefault(code_point, int(src, 16))
    for block in re.findall(r"beginbfrange(.*?)endbfrange", cmap_source, re.S):
        # Array form first: its entries would otherwise be misread as a run of
        # contiguous triples by the pattern below.
        array_pattern = rf"{_HEX_TOKEN}\s+{_HEX_TOKEN}\s*\[([^\]]*)\]"
        consumed: list[str] = []
        for match in re.finditer(array_pattern, block):
            consumed.append(match.group(0))
            low_code = int(match.group(1), 16)
            for offset, dst in enumerate(re.findall(_HEX_TOKEN, match.group(3))):
                code_point = _utf16be_codepoint(dst)
                if code_point is not None:
                    mapping.setdefault(code_point, low_code + offset)
        for chunk in consumed:
            block = block.replace(chunk, " ")
        pattern = rf"{_HEX_TOKEN}\s+{_HEX_TOKEN}\s+{_HEX_TOKEN}"
        for low, high, dst in re.findall(pattern, block):
            low_code, high_code = int(low, 16), int(high, 16)
            base = _utf16be_codepoint(dst)
            if base is None or not 0 <= high_code - low_code <= 0xFFFF:
                continue
            for offset in range(high_code - low_code + 1):
                mapping.setdefault(base + offset, low_code + offset)
    return mapping


def _new_cmap_subtable(fmt: int, platform_id: int, encoding_id: int, table: dict):
    subtable = CmapSubtable.newSubtable(fmt)
    subtable.platformID = platform_id
    subtable.platEncID = encoding_id
    subtable.language = 0
    subtable.cmap = dict(table)
    if fmt == 12:
        subtable.format, subtable.reserved, subtable.length = 12, 0, 0
        subtable.nGroups = 0
    return subtable


def _with_synthesized_cmap(buffer: bytes, mapping: dict[int, int]) -> bytes | None:
    """Rebuild a font program with a unicode cmap derived from `mapping`.

    Identity-H CID fonts are indexed by glyph id and ship no cmap at all, so
    neither the browser (@font-face) nor PyMuPDF can go from a character to a
    glyph. With /CIDToGIDMap /Identity the character code *is* the glyph id,
    so the ToUnicode map read backwards gives exactly the missing table.
    """
    try:
        tt = TTFont(io.BytesIO(buffer), fontNumber=0)
        glyph_order = tt.getGlyphOrder()
        table = {
            code_point: glyph_order[gid]
            for code_point, gid in mapping.items()
            if 0 < gid < len(glyph_order)
        }
        if not table:
            return None
        cmap = newTable("cmap")
        cmap.tableVersion = 0
        bmp = {cp: name for cp, name in table.items() if cp <= 0xFFFF}
        # (3,1) is what Windows/browsers look for, (0,3) what some readers want.
        cmap.tables = [
            _new_cmap_subtable(4, platform_id, encoding_id, bmp)
            for platform_id, encoding_id in ((3, 1), (0, 3))
            if bmp
        ]
        if len(table) > len(bmp):
            cmap.tables.append(_new_cmap_subtable(12, 3, 10, table))
        tt["cmap"] = cmap
        _ensure_post_table(tt)
        out = io.BytesIO()
        tt.save(out)
        return out.getvalue()
    except Exception:
        return None


def _ensure_post_table(tt: TTFont) -> None:
    """Add a minimal `post` table when the subset dropped it.

    PDF embedding has no use for `post`, so subsetters routinely strip it —
    but browsers run every @font-face through the OpenType sanitizer, which
    rejects a TrueType font outright when `post` is missing. Version 3.0
    declares "no glyph names", which is all that is needed here.
    """
    if "post" in tt:
        return
    post = newTable("post")
    post.formatType = 3.0
    post.italicAngle = 0.0
    post.underlinePosition = 0
    post.underlineThickness = 0
    post.isFixedPitch = 0
    post.minMemType42 = post.maxMemType42 = 0
    post.minMemType1 = post.maxMemType1 = 0
    tt["post"] = post


def preview_font_buffer(doc: pymupdf.Document, xref: int) -> tuple[bytes, str] | None:
    """Font program to expose to the editor as @font-face, or None.

    Prefers the *complete* family (same lookup the export uses) over the
    document's embedded subset. A subset only carries the glyphs the original
    text needed, and CSS falls back per character, so previewing through it
    renders any newly typed letter in a different typeface mid-word — while
    the export, which resolves the full family, renders it correctly. Serving
    the same file to both is what keeps them honest.
    """
    basefont = doc.xref_get_key(xref, "BaseFont")
    if basefont and basefont[0] == "name":
        resolved = resolve_family_file(basefont[1].lstrip("/"))
        if resolved is not None:
            path, _source = resolved
            try:
                return path.read_bytes(), path.suffix.lstrip(".").lower()
            except OSError:
                pass
    return embedded_font_buffer(doc, xref)


def _maps_code_to_glyph_id(doc: pymupdf.Document, xref: int) -> bool:
    """True if this font's character codes *are* its glyph indices.

    That equivalence is what lets a ToUnicode map be reversed into a cmap,
    and it only holds for a Type0 font with Identity encoding whose
    descendant uses /CIDToGIDMap /Identity (the default for CIDFontType2).
    A simple TrueType font maps codes through /Encoding instead, and a
    CIDToGIDMap *stream* remaps them explicitly — synthesizing a cmap from
    either would silently point every character at the wrong glyph.
    """
    subtype = doc.xref_get_key(xref, "Subtype")
    if not subtype or subtype[1] != "/Type0":
        return False
    encoding = doc.xref_get_key(xref, "Encoding")
    if not encoding or encoding[1] not in ("/Identity-H", "/Identity-V"):
        return False
    descendants = doc.xref_get_key(xref, "DescendantFonts")
    if not descendants or descendants[0] == "null":
        return False
    match = re.search(r"(\d+)\s+\d+\s+R", descendants[1])
    if not match:
        return False
    cid_to_gid = doc.xref_get_key(int(match.group(1)), "CIDToGIDMap")
    # Absent defaults to Identity per the spec — and PyMuPDF reports absence
    # as the truthy tuple ("null", "null"), so it has to be matched explicitly
    # rather than by falsiness. A name must say Identity; a stream never is.
    return cid_to_gid[0] == "null" or cid_to_gid[1] == "/Identity"


def cff_to_otf(buffer: bytes, basefont: str) -> bytes | None:
    """Wrap a bare CFF font program in an OpenType container.

    PDFs from InDesign & co. embed PostScript outlines as a naked CFF table.
    PyMuPDF (FreeType) reads that directly, so the *export* reuses the real
    typeface — but no browser does: a font must be an sfnt. Without this the
    editor preview silently drops to a system look-alike while the export keeps
    the original, which is exactly the preview/export mismatch to avoid.

    The character map is rebuilt from the CFF's own PostScript glyph names via
    the Adobe Glyph List, and the metrics from its charstrings.
    """
    try:
        fontset = CFFFontSet()
        fontset.decompile(io.BytesIO(buffer), None)
        top = fontset[fontset.fontNames[0]]
        # FontMatrix is 1/upem on the diagonal; PostScript fonts use 1000.
        upem = round(1 / top.FontMatrix[0]) if top.FontMatrix[0] else 1000
        order = [name for name in top.charset if name != ".notdef"]
        order.insert(0, ".notdef")

        charstrings = {}
        metrics = {}
        for name in order:
            charstring = top.CharStrings[name]
            pen = BoundsPen(None)
            charstring.draw(pen)  # also resolves the charstring's own width
            width = charstring.width
            if width is None:
                width = getattr(top.Private, "defaultWidthX", 0)
            metrics[name] = (round(width), round(pen.bounds[0]) if pen.bounds else 0)
            charstrings[name] = charstring

        cmap: dict[int, str] = {}
        for name in order:
            text = agl.toUnicode(name)
            if len(text) == 1 and ord(text) not in cmap:
                cmap[ord(text)] = name
        if not cmap:
            return None  # nothing addressable by character: useless as a preview

        family = basefont.split("+")[-1] or "PdfFont"
        _x0, y0, _x1, y1 = top.FontBBox
        builder = FontBuilder(upem, isTTF=False)
        builder.setupGlyphOrder(order)
        builder.setupCharacterMap(cmap)
        builder.setupCFF(family, {"FullName": family}, charstrings, {})
        builder.setupHorizontalMetrics(metrics)
        builder.setupHorizontalHeader(ascent=round(y1), descent=round(y0))
        builder.setupNameTable(
            {
                "familyName": family,
                "styleName": "Regular",
                "psName": family,
                "fullName": family,
                "version": "1.0",
                "uniqueFontIdentifier": basefont,
            }
        )
        builder.setupOS2(
            sTypoAscender=round(y1),
            sTypoDescender=round(y0),
            usWinAscent=round(y1),
            usWinDescent=abs(round(y0)),
        )
        builder.setupPost()
        out = io.BytesIO()
        builder.save(out)
        return out.getvalue()
    except Exception:
        return None


def embedded_font_buffer(doc: pymupdf.Document, xref: int) -> tuple[bytes, str] | None:
    """Extract a font program, adding a unicode cmap when it lacks one.

    Returns (buffer, extension) or None when the font is not embedded, not a
    supported format, or cannot be made unicode-addressable.
    """
    try:
        name, ext, _type, buffer = doc.extract_font(xref)
    except Exception:
        return None
    if not buffer:
        return None
    if ext == "cff":
        wrapped = cff_to_otf(buffer, name)
        return (wrapped, "otf") if wrapped else None
    if ext not in ("ttf", "otf"):
        return None
    if _font_has_unicode_cmap(buffer):
        return buffer, ext
    if not _maps_code_to_glyph_id(doc, xref):
        return None
    tounicode = doc.xref_get_key(xref, "ToUnicode")
    if not tounicode or tounicode[0] != "xref":
        return None
    try:
        source = doc.xref_stream(int(tounicode[1].split()[0])).decode("latin-1")
    except Exception:
        return None
    patched = _with_synthesized_cmap(buffer, parse_tounicode(source))
    return (patched, ext) if patched else None


def page_preview_fonts(
    doc: pymupdf.Document, page: pymupdf.Page
) -> dict[str, tuple[int, str, bool, bool]]:
    """Map normalized embedded font names to (xref, css-format, bold, italic).

    Only programs the browser can address by character are offered: ttf/otf that
    carry a unicode cmap (or get one synthesized from their ToUnicode map), and
    bare CFF wrapped into an OpenType container — see `embedded_font_buffer`.
    The ext filter also keeps non-embedded base-14 fonts out of the family
    lookup in `preview_font_buffer`, which can reach the network.
    """
    result: dict[str, tuple[int, str, bool, bool]] = {}
    for entry in page.get_fonts(full=True):
        xref, ext, basefont = entry[0], entry[1], entry[3]
        if ext not in ("ttf", "otf", "cff"):
            continue
        extracted = preview_font_buffer(doc, xref)
        if extracted is None:
            continue
        # The served format is what the buffer actually is, not what the PDF
        # embedded: a wrapped CFF ships as OpenType, and a resolved family file
        # may differ from the document's own program.
        _buffer, served = extracted
        _family, bold, italic = parse_font_name(basefont)
        result[_normalize_font_name(basefont)] = (
            xref,
            "truetype" if served == "ttf" else "opentype",
            bold,
            italic,
        )
    return result


@app.get("/documents/font")
def document_font(path: str, xref: int) -> Response:
    """Return an embedded font program (ttf/otf) for the editor's @font-face."""
    file = resolve_file(path)
    with pymupdf.open(file) as doc:
        if not 0 < xref < doc.xref_length():
            raise HTTPException(status_code=404, detail="font not found")
        extracted = preview_font_buffer(doc, xref)
        if extracted is None:
            raise HTTPException(status_code=404, detail="font not extractable")
        buffer, ext = extracted
        media = "font/ttf" if ext == "ttf" else "font/otf"
        return Response(content=buffer, media_type=media)


@app.get("/documents/structure")
def document_structure(path: str) -> dict:
    """Extract the editable structure of a PDF.

    Coordinates use PyMuPDF's convention: origin at the top-left of the page,
    y growing downward, units in PDF points — which matches what the frontend
    overlay needs when scaling to the pdf.js canvas.

    Span ids (p<page>-b<block>-l<line>-s<span>) are stable for a given file
    and are what the edit journal will reference in step 4.
    """
    file = resolve_file(path)
    try:
        with pymupdf.open(file) as doc:
            if not doc.is_pdf:
                raise HTTPException(status_code=422, detail="not a PDF")
            pages = []
            # xref -> (css format, bold, italic), doc-wide
            preview_fonts: dict[int, tuple[str, bool, bool]] = {}
            for page_index, page in enumerate(doc):
                spans = []
                # Embedded fonts of this page usable as @font-face previews.
                page_fonts = page_preview_fonts(doc, page)
                for xref, fmt, bold, italic in page_fonts.values():
                    preview_fonts[xref] = (fmt, bold, italic)

                def match_preview_font(font_name: str) -> int | None:
                    target = _normalize_font_name(font_name)
                    if target in page_fonts:
                        return page_fonts[target][0]
                    for name, entry in page_fonts.items():
                        if name.startswith(target) or target.startswith(name):
                            return entry[0]
                    return None

                text = page.get_text("dict")
                for block_index, block in enumerate(text["blocks"]):
                    if block["type"] != 0:
                        continue
                    for line_index, line in enumerate(block["lines"]):
                        for span_index, span in enumerate(line["spans"]):
                            if not span["text"].strip():
                                continue
                            spans.append(
                                {
                                    "id": f"p{page_index}-b{block_index}"
                                    f"-l{line_index}-s{span_index}",
                                    "text": span["text"],
                                    "bbox": list(span["bbox"]),
                                    # Baseline start point, needed to reinsert
                                    # text at the exact original position.
                                    "origin": list(span["origin"]),
                                    "font": span["font"],
                                    "size": span["size"],
                                    "color": _color_to_hex(span["color"]),
                                    "bold": bool(span["flags"] & _FLAG_BOLD),
                                    "italic": bool(span["flags"] & _FLAG_ITALIC),
                                    # xref of the embedded font to preview, if any.
                                    "fontFile": match_preview_font(span["font"]),
                                }
                            )
                images = []
                page_area = page.rect.width * page.rect.height
                # get_image_info reflects images actually drawn on the page
                # (get_images also lists stale resources left by earlier
                # replace/delete operations). Skip inline images (xref 0,
                # not addressable) and 1x1 placeholders left by delete_image.
                for image_index, info in enumerate(page.get_image_info(xrefs=True)):
                    if info["xref"] == 0:
                        continue
                    if info["width"] <= 1 and info["height"] <= 1:
                        continue
                    bbox = info["bbox"]
                    # A near-full-page image is a flattened template/background
                    # painted under the real text. Its interactive overlay must
                    # not swallow clicks meant for the text spans on top of it.
                    coverage = ((bbox[2] - bbox[0]) * (bbox[3] - bbox[1])) / page_area
                    images.append(
                        {
                            "id": f"p{page_index}-i{image_index}",
                            "xref": info["xref"],
                            "bbox": list(bbox),
                            "background": coverage >= _BACKGROUND_COVERAGE,
                        }
                    )
                pages.append(
                    {
                        "number": page_index,
                        "width": page.rect.width,
                        "height": page.rect.height,
                        "spans": spans,
                        "images": images,
                    }
                )
            # bold/italic ride along so the editor can declare them on the
            # @font-face: a bold-only program registered as a regular face gets
            # the browser's synthetic bold piled on top of it.
            fonts = [
                {"xref": xref, "format": fmt, "bold": bold, "italic": italic}
                for xref, (fmt, bold, italic) in preview_fonts.items()
            ]
            return {"pageCount": doc.page_count, "pages": pages, "fonts": fonts}
    except pymupdf.FileDataError as exc:
        raise HTTPException(status_code=422, detail=f"cannot open PDF: {exc}") from exc


@app.get("/documents/image")
def document_image(path: str, xref: int) -> Response:
    """Return a single embedded image (by xref) as PNG, for the editor preview.

    Always re-encoded to PNG (composing any soft mask) so the browser can
    render it regardless of the original in-PDF colorspace/format.
    """
    file = resolve_file(path)
    with pymupdf.open(file) as doc:
        if not doc.is_pdf:
            raise HTTPException(status_code=422, detail="not a PDF")
        if not 0 < xref < doc.xref_length():
            raise HTTPException(status_code=404, detail="image not found")
        try:
            pix = pymupdf.Pixmap(doc, xref)
        except Exception as exc:  # xref is not an image
            raise HTTPException(status_code=404, detail="image not found") from exc
        if pix.colorspace is not None and pix.colorspace.n > 3:
            pix = pymupdf.Pixmap(pymupdf.csRGB, pix)
        return Response(content=pix.tobytes("png"), media_type="image/png")


class TextEditOperation(BaseModel):
    type: Literal["edit_text"]
    pageNumber: int
    spanId: str
    bbox: tuple[float, float, float, float]
    origin: tuple[float, float]
    newText: str
    font: str
    size: float
    color: str
    bold: bool
    italic: bool
    # True when the user manually resized the text box: the size is then taken
    # as chosen and shrink-to-fit is bounded by the box width alone (no page
    # right-margin expansion — that auto-growth is only for in-place edits).
    boxResized: bool = False


class DeleteImageOperation(BaseModel):
    type: Literal["delete_image"]
    pageNumber: int
    imageId: str
    xref: int


class ReplaceImageOperation(BaseModel):
    type: Literal["replace_image"]
    pageNumber: int
    imageId: str
    xref: int
    # PNG or JPEG bytes; PyMuPDF stretches the new image into the original
    # placement rect, so no geometry is needed.
    imageBase64: str


class PlaceImageOperation(BaseModel):
    type: Literal["place_image"]
    pageNumber: int
    imageId: str
    xref: int
    # New placement rectangle in PDF points, top-left origin (same convention
    # as extraction). The image (original or replacement) is drawn stretched
    # into this rect, replacing its former placement.
    rect: tuple[float, float, float, float]
    # Sub-region of the source image to keep, as fractions [left, top, right,
    # bottom] in 0..1. None keeps the whole image.
    crop: tuple[float, float, float, float] | None = None
    # Replacement bytes (PNG/JPEG base64); None reuses the original image.
    imageBase64: str | None = None


Operation = Annotated[
    TextEditOperation
    | DeleteImageOperation
    | ReplaceImageOperation
    | PlaceImageOperation,
    Field(discriminator="type"),
]

# Decoded replacement images larger than this are refused.
MAX_IMAGE_BYTES = 15 * 1024 * 1024


class ExportRequest(BaseModel):
    sourcePath: str
    targetPath: str
    operations: list[Operation]


# --- Font selection (step 6) ---------------------------------------------
#
# Order of preference when reinserting edited text:
#   1. the span's own embedded font, if its (often subsetted) glyph table
#      covers every character of the new text;
#   2. the *same typeface* in full, resolved by family name from the font
#      library (see resolve_named_font) — embedded subsets only carry the
#      glyphs the original document used, so typing any new character drops
#      out of (1) even though the typeface itself is perfectly identifiable;
#   3. a metrically close free font (Liberation, then Noto/DejaVu) matching
#      family/weight/style;
#   4. a base-14 standard font as last resort.

_BASE14 = {
    "sans": {(False, False): "helv", (True, False): "hebo", (False, True): "heit", (True, True): "hebi"},
    "serif": {(False, False): "tiro", (True, False): "tibo", (False, True): "tiit", (True, True): "tibi"},
    "mono": {(False, False): "cour", (True, False): "cobo", (False, True): "coit", (True, True): "cobi"},
}

_FALLBACK_FILES = {
    ("sans", False, False): ["LiberationSans-Regular.ttf", "NotoSans-Regular.ttf", "DejaVuSans.ttf"],
    ("sans", True, False): ["LiberationSans-Bold.ttf", "NotoSans-Bold.ttf", "DejaVuSans-Bold.ttf"],
    ("sans", False, True): ["LiberationSans-Italic.ttf", "NotoSans-Italic.ttf", "DejaVuSans-Oblique.ttf"],
    ("sans", True, True): ["LiberationSans-BoldItalic.ttf", "NotoSans-BoldItalic.ttf", "DejaVuSans-BoldOblique.ttf"],
    ("serif", False, False): ["LiberationSerif-Regular.ttf", "NotoSerif-Regular.ttf", "DejaVuSerif.ttf"],
    ("serif", True, False): ["LiberationSerif-Bold.ttf", "NotoSerif-Bold.ttf", "DejaVuSerif-Bold.ttf"],
    ("serif", False, True): ["LiberationSerif-Italic.ttf", "NotoSerif-Italic.ttf", "DejaVuSerif-Italic.ttf"],
    ("serif", True, True): ["LiberationSerif-BoldItalic.ttf", "NotoSerif-BoldItalic.ttf", "DejaVuSerif-BoldItalic.ttf"],
    ("mono", False, False): ["LiberationMono-Regular.ttf", "NotoSansMono-Regular.ttf", "DejaVuSansMono.ttf"],
    ("mono", True, False): ["LiberationMono-Bold.ttf", "NotoSansMono-Bold.ttf", "DejaVuSansMono-Bold.ttf"],
    ("mono", False, True): ["LiberationMono-Italic.ttf", "DejaVuSansMono-Oblique.ttf"],
    ("mono", True, True): ["LiberationMono-BoldItalic.ttf", "DejaVuSansMono-BoldOblique.ttf"],
}

_FONT_DIRS = ("/usr/share/fonts", "/usr/local/share/fonts")


@functools.lru_cache(maxsize=1)
def system_font_files() -> dict[str, str]:
    """Map of lowercase font file names to paths, scanned once per process."""
    files: dict[str, str] = {}
    for font_dir in _FONT_DIRS:
        for dirpath, _dirnames, filenames in os.walk(font_dir):
            for filename in filenames:
                if filename.lower().endswith((".ttf", ".otf")):
                    files.setdefault(filename.lower(), os.path.join(dirpath, filename))
    return files


def pick_family_and_style(font_name: str, bold: bool, italic: bool) -> tuple[str, bool, bool]:
    name = font_name.lower()
    if "courier" in name or "mono" in name:
        family = "mono"
    elif ("times" in name or "serif" in name or "roman" in name or "georgia" in name or "garamond" in name) and "sans" not in name:
        family = "serif"
    else:
        family = "sans"
    # Some fonts carry the weight/style only in their name.
    bold = bold or "bold" in name or "black" in name or "heavy" in name
    italic = italic or "italic" in name or "oblique" in name
    return family, bold, italic


# --- Font library: resolving a typeface by name --------------------------
#
# Downloaded/user-supplied fonts live here. Keeping it on the shared volume
# means a family is fetched once and then reused by every later export, and
# that operators can drop in licensed fonts we could never download.
FONTS_DIR = Path(os.environ.get("FONTS_DIR", "/data/fonts"))

# Outbound fetching is opt-out: without it the service still works, it just
# falls back to look-alikes for any typeface not already in FONTS_DIR.
FONT_DOWNLOAD_ENABLED = os.environ.get("FONT_DOWNLOAD_ENABLED", "1") != "0"
FONT_DOWNLOAD_TIMEOUT = float(os.environ.get("FONT_DOWNLOAD_TIMEOUT", "10"))

# Weight/style words that name a *variant* rather than the family itself.
# "Roman" is deliberately absent: it is part of Times New Roman far more
# often than it is a weight marker.
_STYLE_WORDS = {
    "regular": (False, False), "normal": (False, False), "book": (False, False),
    "italic": (False, True), "oblique": (False, True),
    "bold": (True, False), "semibold": (True, False), "demibold": (True, False),
    "extrabold": (True, False), "ultrabold": (True, False), "black": (True, False),
    "heavy": (True, False), "medium": (False, False), "light": (False, False),
    "extralight": (False, False), "ultralight": (False, False), "thin": (False, False),
}
# Camel-case splits "SemiBold" into two words; these glue back onto the next.
_STYLE_PREFIXES = ("semi", "demi", "extra", "ultra")
# Foundry/format markers glued onto PostScript names (TimesNewRomanPSMT).
_NAME_NOISE = {"mt", "ps", "psmt", "pscm"}


def parse_font_name(font_name: str) -> tuple[str, bool, bool]:
    """Split a PDF font name into (family, bold, italic).

    PDF font names are PostScript names, so the family is welded to its
    variant and to the subset prefix: "IUNIYH+Anton-Regular",
    "IBMPlexSans-SemiBold", "TimesNewRomanPSMT". Splitting on separators and
    on camel-case boundaries recovers the words, and any word that names a
    weight or a slant is peeled off as style rather than kept as family.
    """
    name = font_name.split("+")[-1].split(",")[0]
    words: list[str] = []
    for chunk in re.split(r"[-_\s]+", name):
        # "IBMPlexSans" -> IBM, Plex, Sans; "Anton2" -> Anton, 2
        words.extend(re.findall(r"[A-Z]+(?![a-z])|[A-Z][a-z]*|[a-z]+|[0-9]+", chunk))
    merged: list[str] = []
    for word in words:
        if merged and merged[-1].lower() in _STYLE_PREFIXES:
            merged[-1] += word
        else:
            merged.append(word)
    family_words, bold, italic = [], False, False
    for word in merged:
        key = word.lower()
        if key in _STYLE_WORDS:
            word_bold, word_italic = _STYLE_WORDS[key]
            bold, italic = bold or word_bold, italic or word_italic
        elif key not in _NAME_NOISE:
            family_words.append(word)
    return " ".join(family_words), bold, italic


def _font_identity(path: Path) -> tuple[str, bool, bool] | None:
    """(family, bold, italic) a font file declares for itself, or None.

    Both name records matter: id 1 carries the family alone ("Anton") and id 2
    the subfamily ("Bold Italic"). Reading only id 1 would file every weight of
    a family under the same key, so a bold lookup would quietly get the
    regular cut — and never re-download the bold one.
    """
    try:
        tt = TTFont(path, fontNumber=0, lazy=True)
    except Exception:
        return None
    try:
        if "name" not in tt:
            return None
        family = tt["name"].getDebugName(1)
        subfamily = tt["name"].getDebugName(2) or ""
    except Exception:
        return None
    finally:
        tt.close()
    if not family:
        return None
    _ignored, bold, italic = parse_font_name(subfamily)
    return family, bold, italic


def _variant_filename(family: str, bold: bool, italic: bool) -> str:
    slug = re.sub(r"[^A-Za-z0-9]+", "-", family).strip("-")
    return f"{slug}-{'700' if bold else '400'}-{'italic' if italic else 'normal'}.ttf"


# Cached index plus the directory mtime it was built from. Creating,
# replacing or deleting a font file bumps that mtime, so a download landing
# mid-process invalidates the cache on its own.
_library_cache: tuple[int, dict[tuple[str, bool, bool], Path]] | None = None


def font_library_index() -> dict[tuple[str, bool, bool], Path]:
    """Index FONTS_DIR by (normalized family, bold, italic).

    Cached against the directory mtime: this runs once per font per page
    during extraction and once per edit during export, and each rebuild
    parses the name table of every file in the library.
    """
    global _library_cache
    try:
        stamp = FONTS_DIR.stat().st_mtime_ns
    except OSError:
        return {}
    if _library_cache is not None and _library_cache[0] == stamp:
        return _library_cache[1]
    index: dict[tuple[str, bool, bool], Path] = {}
    for path in sorted(FONTS_DIR.iterdir()):
        if path.suffix.lower() not in (".ttf", ".otf"):
            continue
        # Fall back to the filename for files we cannot introspect.
        identity = _font_identity(path) or parse_font_name(path.stem)
        family, bold, italic = identity
        if family:
            index.setdefault((_normalize_font_name(family), bold, italic), path)
    _library_cache = (stamp, index)
    return index


def _google_font_url(family: str, bold: bool, italic: bool) -> str | None:
    """Ask the Google Fonts CSS API for a direct TrueType URL, or None.

    A legacy User-Agent matters: modern ones are served woff2, which PyMuPDF
    cannot read, while an old one gets plain .ttf.
    """
    from urllib.error import HTTPError
    from urllib.parse import quote
    from urllib.request import Request, urlopen

    axis = f":ital,wght@{1 if italic else 0},{700 if bold else 400}"
    for suffix in (axis, ""):
        url = f"https://fonts.googleapis.com/css2?family={quote(family)}{suffix}"
        try:
            request = Request(url, headers={"User-Agent": "Mozilla/4.0"})
            with urlopen(request, timeout=FONT_DOWNLOAD_TIMEOUT) as response:
                css = response.read().decode("utf-8", "replace")
        except HTTPError:
            continue  # unknown family, or that weight/slant is not published
        except Exception:
            return None  # network down: retrying the bare family just re-waits
        match = re.search(r"src:\s*url\((https://[^)]+?\.ttf)\)", css)
        if match:
            return match.group(1)
    return None


# Families the network could not supply, so an export never pays that latency
# twice. Process-local on purpose: a restart re-tries, which is what you want
# after fixing connectivity.
_UNAVAILABLE_FAMILIES: set[tuple[str, bool, bool]] = set()


def download_font(family: str, bold: bool, italic: bool) -> Path | None:
    """Fetch a family from Google Fonts into FONTS_DIR; None if unavailable.

    Google Fonts are OFL/Apache licensed, so embedding what comes back in an
    exported PDF is permitted. Anything else has to be dropped into FONTS_DIR
    by the operator.
    """
    key = (_normalize_font_name(family), bold, italic)
    if not FONT_DOWNLOAD_ENABLED or not family or key in _UNAVAILABLE_FAMILIES:
        return None
    url = _google_font_url(family, bold, italic)
    if not url:
        _UNAVAILABLE_FAMILIES.add(key)
        return None
    from urllib.request import Request, urlopen

    try:
        request = Request(url, headers={"User-Agent": "Mozilla/4.0"})
        with urlopen(request, timeout=FONT_DOWNLOAD_TIMEOUT) as response:
            payload = response.read()
        pymupdf.Font(fontbuffer=payload)  # reject anything unreadable
        FONTS_DIR.mkdir(parents=True, exist_ok=True)
        target = FONTS_DIR / _variant_filename(family, bold, italic)
        # Write aside then rename: readers only ever see a complete file, and
        # the pid keeps two exports racing on the same family from sharing
        # (and truncating) one temporary.
        temporary = target.with_suffix(f".{os.getpid()}.part")
        temporary.write_bytes(payload)
        temporary.replace(target)
        return target
    except Exception:
        _UNAVAILABLE_FAMILIES.add(key)
        return None


def resolve_family_file(
    font_name: str, bold: bool = False, italic: bool = False
) -> tuple[Path, str] | None:
    """Locate the full font file for the typeface named by `font_name`.

    Shared by the export and the editor preview so both render text with the
    very same file — serving the preview a subset while the export uses the
    complete family is what makes letters silently change typeface mid-word.
    """
    family, name_bold, name_italic = parse_font_name(font_name)
    if not family:
        return None
    bold, italic = bold or name_bold, italic or name_italic
    key = (_normalize_font_name(family), bold, italic)

    index = font_library_index()
    if key in index:
        return index[key], "library"
    downloaded = download_font(family, bold, italic)
    if downloaded is not None:
        return downloaded, "downloaded"
    # Only now: an upright cut of the right family still beats a different
    # family entirely. Checked last, because matching it earlier would mask
    # the requested weight and stop us from ever fetching it.
    upright = font_library_index().get((key[0], False, False))
    return (upright, "library") if upright is not None else None


def resolve_named_font(
    font_name: str, bold: bool, italic: bool, text: str
) -> tuple[pymupdf.Font, str] | None:
    """Load the real typeface named by `font_name`, covering `text`.

    Returns None whenever the result would not actually cover the text, so
    the caller can drop to a metric look-alike rather than emit notdef boxes.
    """
    resolved = resolve_family_file(font_name, bold, italic)
    if resolved is None:
        return None
    path, source = resolved
    try:
        font = pymupdf.Font(fontfile=str(path))
    except Exception:
        return None
    return (font, f"{source}:{path.name}") if covers_text(font, text) else None


def covers_text(font: pymupdf.Font, text: str) -> bool:
    """True if the font has a real glyph for every visible character of the text.

    Whitespace is exempt: subsets routinely omit the space glyph (producers
    emit inter-word gaps as TJ offsets instead), yet TextWriter still lays out
    a missing space as a plain advance rather than a notdef box. Vetoing on it
    would reject an otherwise perfect embedded font over an invisible glyph.
    """
    return all(font.has_glyph(ord(char)) != 0 for char in text if not char.isspace())


def _normalize_font_name(name: str) -> str:
    """Drop the subset prefix (ABCDEF+) and spaces for tolerant comparison."""
    return name.split("+")[-1].replace(" ", "").lower()


def find_embedded_font(
    doc: pymupdf.Document, page: pymupdf.Page, span_font_name: str
) -> pymupdf.Font | None:
    """Load the span's own embedded font program, if extractable.

    Resource names rarely match the extracted span font name exactly
    ("Liberation Sans Regular" vs "LiberationSans"), so after an exact
    normalized match we accept a containment match.
    """
    target = _normalize_font_name(span_font_name)
    candidates: list[tuple[int, int, str]] = []  # (rank, xref, ext)
    for entry in page.get_fonts(full=True):
        xref, ext, basefont = entry[0], entry[1], entry[3]
        name = _normalize_font_name(basefont)
        if name == target:
            rank = 0
        elif name.startswith(target) or target.startswith(name):
            rank = 1
        else:
            continue
        candidates.append((rank, xref, ext))
    if not candidates:
        return None
    _rank, xref, ext = min(candidates)
    if ext not in ("ttf", "otf", "cff"):
        return None  # not embedded (base-14) or an unsupported format
    if ext == "cff":
        try:
            _name, _ext, _type, buffer = doc.extract_font(xref)
        except Exception:
            return None
    else:
        # ttf/otf go through the cmap-synthesizing path, so Identity-H subsets
        # (no cmap of their own) stay reusable instead of falling back.
        extracted = embedded_font_buffer(doc, xref)
        buffer = extracted[0] if extracted else None
    if not buffer:
        return None
    try:
        return pymupdf.Font(fontbuffer=buffer)
    except Exception:
        return None


def choose_font(
    doc: pymupdf.Document, page: pymupdf.Page, operation: "TextEditOperation"
) -> tuple[pymupdf.Font, str]:
    """Pick the best font for the replacement text; returns (font, strategy)."""
    embedded = find_embedded_font(doc, page, operation.font)
    if embedded is not None and covers_text(embedded, operation.newText):
        return embedded, "embedded"

    # The subset did not cover the new text — try the same typeface in full
    # before settling for a look-alike.
    named = resolve_named_font(
        operation.font, operation.bold, operation.italic, operation.newText
    )
    if named is not None:
        return named

    family, bold, italic = pick_family_and_style(
        operation.font, operation.bold, operation.italic
    )
    for filename in _FALLBACK_FILES.get((family, bold, italic), []):
        path = system_font_files().get(filename.lower())
        if not path:
            continue
        try:
            font = pymupdf.Font(fontfile=path)
        except Exception:
            continue
        if covers_text(font, operation.newText):
            return font, f"fallback:{filename.removesuffix('.ttf')}"

    code = _BASE14[family][(bold, italic)]
    return pymupdf.Font(code), f"base14:{code}"


# Text shrunk below this size to fit its line is left overflowing instead.
MIN_FITTED_FONTSIZE = 6.0
_PAGE_RIGHT_MARGIN = 36.0


def fitted_fontsize(
    font: pymupdf.Font,
    operation: "TextEditOperation",
    page: pymupdf.Page,
) -> float:
    """Shrink the font size just enough for the new text to fit its line.

    For in-place edits the text may grow past the original span bbox up to the
    page right margin; beyond that the size is reduced (never below
    MIN_FITTED_FONTSIZE). When the box was manually resized, only its own width
    bounds the text — the user's box wins over the auto-growth heuristic.
    """
    box_width = operation.bbox[2] - operation.bbox[0]
    if operation.boxResized:
        available = box_width
    else:
        available = max(
            box_width,
            page.rect.x1 - _PAGE_RIGHT_MARGIN - operation.origin[0],
        )
    if available <= 0:
        return operation.size
    width = font.text_length(operation.newText, fontsize=operation.size)
    if width <= available:
        return operation.size
    return max(operation.size * available / width, MIN_FITTED_FONTSIZE)


def hex_to_rgb(color: str) -> tuple[float, float, float]:
    value = color.lstrip("#")
    if len(value) != 6:
        return (0.0, 0.0, 0.0)
    return tuple(int(value[i : i + 2], 16) / 255 for i in (0, 2, 4))


def _decode_image_bytes(data: bytes) -> pymupdf.Pixmap:
    """Decode replacement/source bytes to an RGB(A) pixmap for cropping."""
    try:
        pix = pymupdf.Pixmap(data)
    except Exception as exc:
        raise HTTPException(status_code=422, detail="unsupported image format") from exc
    # CMYK (or other >3 component) spaces can't be re-encoded to PNG directly.
    if pix.colorspace is not None and pix.colorspace.n > 3:
        pix = pymupdf.Pixmap(pymupdf.csRGB, pix)
    return pix


def _cropped_pixmap(pix: pymupdf.Pixmap, crop: tuple[float, float, float, float]) -> pymupdf.Pixmap:
    """Keep the [left, top, right, bottom] fractional sub-region of a pixmap."""
    left, top, right, bottom = crop
    x0 = max(0, min(pix.width, round(left * pix.width)))
    y0 = max(0, min(pix.height, round(top * pix.height)))
    x1 = max(x0 + 1, min(pix.width, round(right * pix.width)))
    y1 = max(y0 + 1, min(pix.height, round(bottom * pix.height)))
    clip = pymupdf.IRect(x0, y0, x1, y1)
    cropped = pymupdf.Pixmap(pix.colorspace, clip, pix.alpha)
    cropped.copy(pix, clip)
    return cropped


def _place_image(
    doc: pymupdf.Document, page: pymupdf.Page, operation: "PlaceImageOperation"
) -> None:
    """Redraw an image (original or replacement) into a new rect, cropped."""
    rect = pymupdf.Rect(*operation.rect)
    if rect.is_empty or not rect.is_valid:
        raise HTTPException(status_code=422, detail="invalid image placement rect")

    if operation.imageBase64 is not None:
        try:
            data = base64.b64decode(operation.imageBase64, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise HTTPException(status_code=422, detail="invalid image encoding") from exc
        if len(data) > MAX_IMAGE_BYTES:
            raise HTTPException(status_code=422, detail="image too large")
    else:
        extracted = doc.extract_image(operation.xref)
        data = extracted.get("image") if extracted else None
        if not data:
            raise HTTPException(
                status_code=422, detail=f"cannot extract image {operation.xref}"
            )

    # Remove the former placement before drawing the new one.
    page.delete_image(operation.xref)

    if operation.crop is not None and operation.crop != (0.0, 0.0, 1.0, 1.0):
        pix = _cropped_pixmap(_decode_image_bytes(data), operation.crop)
        page.insert_image(rect, pixmap=pix, keep_proportion=False)
    else:
        # Validate decodability even when not cropping.
        _decode_image_bytes(data)
        page.insert_image(rect, stream=data, keep_proportion=False)


# A neighbouring span belongs to another line — and must survive the redaction —
# when its vertical centre sits at least this share of the edited box height away
# from the edited span's centre. Closer than that they are words of the same
# line, whose bboxes overlap ours completely; only the horizontal inset separates
# those.
_NEIGHBOUR_LINE_RATIO = 0.25
# Horizontal overlap (points) below which a neighbour is considered to sit beside
# the edited span rather than above/below it.
_NEIGHBOUR_OVERLAP_PT = 1.0
# Slight inset of the redaction rect, so it never clips glyphs of the adjacent
# word on the same line.
_REDACT_INSET_PT = 0.5


def page_span_boxes(page: pymupdf.Page) -> list[tuple[str, pymupdf.Rect]]:
    """(spanId, bbox) of every text span of the page, ids as in extraction."""
    boxes: list[tuple[str, pymupdf.Rect]] = []
    for block_index, block in enumerate(page.get_text("dict")["blocks"]):
        if block["type"] != 0:
            continue
        for line_index, line in enumerate(block["lines"]):
            for span_index, span in enumerate(line["spans"]):
                if not span["text"].strip():
                    continue
                boxes.append(
                    (
                        f"p{page.number}-b{block_index}-l{line_index}-s{span_index}",
                        pymupdf.Rect(span["bbox"]),
                    )
                )
    return boxes


def redaction_rect(
    bbox: tuple[float, float, float, float],
    neighbours: list[pymupdf.Rect],
) -> pymupdf.Rect | None:
    """The rect to redact for an edited span, clipped off neighbouring lines.

    MuPDF removes every glyph whose bbox *intersects* a redaction rect, and span
    bboxes are font-metric boxes (ascender to descender): tightly leaded lines
    therefore overlap each other vertically. Redacting the raw bbox of a title
    line silently deletes the lines above and below it — real bug, seen on a
    55 pt title with 49 pt leading where editing one line wiped two others.

    Since removal is by intersection, a thin horizontal band inside the span
    still erases all of its glyphs. So we keep only the part of the box that no
    neighbouring line reaches. Returns None when the box is degenerate.
    """
    rect = pymupdf.Rect(*bbox) + (
        _REDACT_INSET_PT,
        _REDACT_INSET_PT,
        -_REDACT_INSET_PT,
        -_REDACT_INSET_PT,
    )
    if rect.is_empty:
        return None

    height = rect.y1 - rect.y0
    centre = (rect.y0 + rect.y1) / 2
    top, bottom = rect.y0, rect.y1
    for other in neighbours:
        overlap = min(rect.x1, other.x1) - max(rect.x0, other.x0)
        if overlap <= _NEIGHBOUR_OVERLAP_PT:
            continue  # beside us, not above or below
        if other.y1 <= rect.y0 or other.y0 >= rect.y1:
            continue  # no vertical conflict
        other_centre = (other.y0 + other.y1) / 2
        if abs(other_centre - centre) < _NEIGHBOUR_LINE_RATIO * height:
            continue  # same line as us
        if other_centre < centre:
            top = max(top, other.y1)
        else:
            bottom = min(bottom, other.y0)

    if bottom - top <= 0:
        # Neighbours cover the whole box: no band can spare them, so fall back
        # to the plain box rather than skipping the edit altogether.
        return rect
    rect.y0, rect.y1 = top, bottom
    return None if rect.is_empty else rect


def delete_signature_fields(doc: pymupdf.Document) -> int:
    """Drop signature form fields — edited exports never preserve signatures."""
    deleted = 0
    for page in doc:
        signature_widgets = [
            widget
            for widget in page.widgets()
            if widget.field_type == pymupdf.PDF_WIDGET_TYPE_SIGNATURE
        ]
        for widget in signature_widgets:
            page.delete_widget(widget)
            deleted += 1
    return deleted


@app.post("/documents/export")
def export_document(request: ExportRequest) -> dict:
    """Replay the edit journal on the source PDF and write a new version.

    Text edits are applied as targeted redactions (original glyphs removed
    from the content stream, not covered) followed by reinsertion at the
    original baseline with the closest standard font.
    """
    source = resolve_file(request.sourcePath)
    target = resolve_target(request.targetPath)

    try:
        doc = pymupdf.open(source)
    except pymupdf.FileDataError as exc:
        raise HTTPException(status_code=422, detail=f"cannot open PDF: {exc}") from exc

    with doc:
        if not doc.is_pdf:
            raise HTTPException(status_code=422, detail="not a PDF")

        text_ops: dict[int, list[TextEditOperation]] = defaultdict(list)
        image_ops: dict[
            int,
            list[DeleteImageOperation | ReplaceImageOperation | PlaceImageOperation],
        ] = defaultdict(list)
        for operation in request.operations:
            if not 0 <= operation.pageNumber < doc.page_count:
                raise HTTPException(
                    status_code=422, detail=f"invalid page {operation.pageNumber}"
                )
            if isinstance(operation, TextEditOperation):
                text_ops[operation.pageNumber].append(operation)
            else:
                image_ops[operation.pageNumber].append(operation)

        font_strategies: dict[str, str] = {}
        for page_number, operations in text_ops.items():
            page = doc[page_number]
            # Choose fonts BEFORE redacting: reusing an embedded font needs
            # the page's original font resources still intact.
            insertions: list[tuple[TextEditOperation, pymupdf.Font, float]] = []
            for operation in operations:
                if not operation.newText:
                    font_strategies[operation.spanId] = "deleted"
                    continue  # emptied text = deletion, nothing to reinsert
                font, strategy = choose_font(doc, page, operation)
                size = fitted_fontsize(font, operation, page)
                if size != operation.size:
                    strategy += ":resized"
                font_strategies[operation.spanId] = strategy
                insertions.append((operation, font, size))
            # Spans left untouched must survive the redaction even when their
            # bbox overlaps an edited one (tight leading). Edited spans are
            # excluded: their originals are redacted and reinserted anyway.
            edited_ids = {operation.spanId for operation in operations}
            neighbours = [
                box
                for span_id, box in page_span_boxes(page)
                if span_id not in edited_ids
            ]
            # Redact all edited spans first, then reinsert, so an inserted
            # text is never wiped by a later redaction on the same page.
            for operation in operations:
                rect = redaction_rect(operation.bbox, neighbours)
                if rect is not None:
                    page.add_redact_annot(rect)
            page.apply_redactions(
                images=pymupdf.PDF_REDACT_IMAGE_NONE,
                graphics=pymupdf.PDF_REDACT_LINE_ART_NONE,
            )
            for operation, font, size in insertions:
                writer = pymupdf.TextWriter(page.rect)
                writer.append(
                    pymupdf.Point(*operation.origin),
                    operation.newText,
                    font=font,
                    fontsize=size,
                )
                writer.write_text(page, color=hex_to_rgb(operation.color))

        for page_number, operations in image_ops.items():
            page = doc[page_number]
            # Never trust a client-supplied xref blindly: it must reference an
            # image actually placed on this page.
            page_image_xrefs = {image[0] for image in page.get_images(full=True)}
            for operation in operations:
                if operation.xref not in page_image_xrefs:
                    raise HTTPException(
                        status_code=422,
                        detail=f"xref {operation.xref} is not an image of page {operation.pageNumber}",
                    )
                if isinstance(operation, DeleteImageOperation):
                    page.delete_image(operation.xref)
                elif isinstance(operation, PlaceImageOperation):
                    _place_image(doc, page, operation)
                else:
                    try:
                        data = base64.b64decode(operation.imageBase64, validate=True)
                    except (binascii.Error, ValueError) as exc:
                        raise HTTPException(
                            status_code=422, detail="invalid image encoding"
                        ) from exc
                    if len(data) > MAX_IMAGE_BYTES:
                        raise HTTPException(status_code=422, detail="image too large")
                    try:
                        # Validates the bytes are a decodable image before
                        # touching the document.
                        pymupdf.Pixmap(data)
                    except Exception as exc:
                        raise HTTPException(
                            status_code=422, detail="unsupported image format"
                        ) from exc
                    # The new image is stretched into the original placement
                    # rect (spec: resized into the original bbox).
                    page.replace_image(operation.xref, stream=data)

        deleted_signatures = delete_signature_fields(doc)
        doc.save(target, garbage=3, deflate=True)
        return {
            "pageCount": doc.page_count,
            "deletedSignatureFields": deleted_signatures,
            "fontStrategies": font_strategies,
        }
