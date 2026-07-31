"""Export regression tests — targeted redaction must not eat neighbouring lines.

MuPDF removes every glyph whose bbox *intersects* a redaction rect, and span
bboxes run from ascender to descender: tightly leaded lines overlap vertically.
Redacting a span's raw bbox therefore deletes its neighbours silently — the
export succeeds, only the resulting PDF is missing text.
"""

import pymupdf
import pytest

import main


@pytest.fixture
def tight_lines(tmp_path, monkeypatch):
    """A page whose three lines are leaded tighter than their bbox height."""
    monkeypatch.setattr(main, "FILES_ROOT", tmp_path)
    doc = pymupdf.open()
    page = doc.new_page(width=595, height=842)
    for index, text in enumerate(("FIRST LINE", "SECOND LINE", "THIRD LINE")):
        page.insert_text((36, 300 + index * 40), text, fontname="helv", fontsize=55)
    doc.save(tmp_path / "src.pdf")
    doc.close()
    return tmp_path


def spans_of(path):
    with pymupdf.open(path) as doc:
        return [
            (span["text"], span["bbox"], span["origin"])
            for block in doc[0].get_text("dict")["blocks"]
            if block["type"] == 0
            for line in block["lines"]
            for span in line["spans"]
            if span["text"].strip()
        ]


def test_fixture_lines_really_overlap(tight_lines):
    """Guard the fixture: without overlapping bboxes the test proves nothing."""
    boxes = [bbox for _text, bbox, _origin in spans_of(tight_lines / "src.pdf")]
    assert boxes[0][3] > boxes[1][1]
    assert boxes[1][3] > boxes[2][1]


def test_editing_a_line_spares_the_lines_above_and_below(tight_lines):
    _text, bbox, origin = spans_of(tight_lines / "src.pdf")[1]
    operation = main.TextEditOperation(
        type="edit_text",
        pageNumber=0,
        spanId="p0-b0-l1-s0",
        bbox=bbox,
        origin=origin,
        newText="EDITED LINE",
        font="helv",
        size=55.0,
        color="#000000",
        bold=False,
        italic=False,
    )
    main.export_document(
        main.ExportRequest(
            sourcePath="src.pdf", targetPath="out.pdf", operations=[operation]
        )
    )
    texts = [text.strip() for text, _bbox, _origin in spans_of(tight_lines / "out.pdf")]
    assert "FIRST LINE" in texts
    assert "THIRD LINE" in texts
    assert "EDITED LINE" in texts
    assert "SECOND LINE" not in texts


def test_words_of_the_same_line_are_not_clipped_away():
    """Same-line neighbours must not shrink the band to nothing.

    Justified producers emit one span per word, all sharing the same vertical
    extent: treating them as "lines above/below" would collapse the redaction
    band and leave the original glyphs in place.
    """
    rect = main.redaction_rect(
        (100.0, 200.0, 160.0, 260.0),
        [pymupdf.Rect(40.0, 200.0, 99.0, 260.0), pymupdf.Rect(161.0, 200.0, 220.0, 260.0)],
    )
    assert rect is not None
    assert rect.y1 - rect.y0 == pytest.approx(59.0)


def test_band_is_clipped_off_the_neighbouring_line():
    rect = main.redaction_rect(
        (36.0, 200.0, 400.0, 260.0),
        [pymupdf.Rect(36.0, 160.0, 400.0, 215.0), pymupdf.Rect(36.0, 250.0, 400.0, 310.0)],
    )
    assert rect is not None
    assert (rect.y0, rect.y1) == (215.0, 250.0)


def test_fully_covered_box_falls_back_to_the_plain_rect():
    """No band can spare a neighbour that covers us entirely — still redact."""
    rect = main.redaction_rect(
        (36.0, 200.0, 400.0, 260.0),
        [pymupdf.Rect(36.0, 100.0, 400.0, 255.0), pymupdf.Rect(36.0, 205.0, 400.0, 400.0)],
    )
    assert rect is not None
    assert (rect.y0, rect.y1) == (200.5, 259.5)
