"""PDF processing service.

Internal-only service (never exposed publicly). Reads and writes PDF files
on the shared /data/files volume; the Next.js app passes file paths relative
to FILES_ROOT, never raw file contents.
"""

import base64
import binascii
import functools
import os
from collections import defaultdict
from pathlib import Path
from typing import Annotated, Literal

import pymupdf
from fastapi import FastAPI, HTTPException
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


def _color_to_hex(color: int) -> str:
    return f"#{color:06x}"


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
            for page_index, page in enumerate(doc):
                spans = []
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
                                }
                            )
                images = []
                # get_image_info reflects images actually drawn on the page
                # (get_images also lists stale resources left by earlier
                # replace/delete operations). Skip inline images (xref 0,
                # not addressable) and 1x1 placeholders left by delete_image.
                for image_index, info in enumerate(page.get_image_info(xrefs=True)):
                    if info["xref"] == 0:
                        continue
                    if info["width"] <= 1 and info["height"] <= 1:
                        continue
                    images.append(
                        {
                            "id": f"p{page_index}-i{image_index}",
                            "xref": info["xref"],
                            "bbox": list(info["bbox"]),
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
            return {"pageCount": doc.page_count, "pages": pages}
    except pymupdf.FileDataError as exc:
        raise HTTPException(status_code=422, detail=f"cannot open PDF: {exc}") from exc


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


Operation = Annotated[
    TextEditOperation | DeleteImageOperation | ReplaceImageOperation,
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
#   2. a metrically close free font (Liberation, then Noto/DejaVu) matching
#      family/weight/style;
#   3. a base-14 standard font as last resort.

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


def covers_text(font: pymupdf.Font, text: str) -> bool:
    """True if the font has a real glyph for every character of the text."""
    return all(font.has_glyph(ord(char)) != 0 for char in text if char != "\n")


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
    _name, _ext, _type, buffer = doc.extract_font(xref)
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

    The text may grow past the original span bbox up to the page right
    margin; beyond that the size is reduced (never below MIN_FITTED_FONTSIZE).
    """
    origin_x = operation.origin[0]
    available = max(
        operation.bbox[2] - operation.bbox[0],
        page.rect.x1 - _PAGE_RIGHT_MARGIN - origin_x,
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
        image_ops: dict[int, list[DeleteImageOperation | ReplaceImageOperation]] = (
            defaultdict(list)
        )
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
            # Redact all edited spans first, then reinsert, so an inserted
            # text is never wiped by a later redaction on the same page.
            for operation in operations:
                rect = pymupdf.Rect(*operation.bbox)
                # Slight inset to avoid clipping glyphs of adjacent spans.
                rect = rect + (0.5, 0.5, -0.5, -0.5)
                if not rect.is_empty:
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
