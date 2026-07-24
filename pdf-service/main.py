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
    """Basic sanity endpoint: open a PDF and return page count and metadata.

    Also serves as the end-to-end check that the shared volume and PyMuPDF
    work inside the container. Structure extraction (spans, images) lands
    in step 3 of the plan.
    """
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
