"""PDF processing service.

Internal-only service (never exposed publicly). Reads and writes PDF files
on the shared /data/files volume; the Next.js app passes file paths relative
to FILES_ROOT, never raw file contents.
"""

import os
from pathlib import Path

import pymupdf
from fastapi import FastAPI, HTTPException

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
                                    "font": span["font"],
                                    "size": span["size"],
                                    "color": _color_to_hex(span["color"]),
                                    "bold": bool(span["flags"] & _FLAG_BOLD),
                                    "italic": bool(span["flags"] & _FLAG_ITALIC),
                                }
                            )
                images = []
                for image_index, image in enumerate(page.get_images(full=True)):
                    xref = image[0]
                    for rect_index, rect in enumerate(page.get_image_rects(xref)):
                        images.append(
                            {
                                "id": f"p{page_index}-i{image_index}-r{rect_index}",
                                "xref": xref,
                                "bbox": [rect.x0, rect.y0, rect.x1, rect.y1],
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
