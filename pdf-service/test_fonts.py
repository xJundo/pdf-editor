"""Regression tests for the font pipeline.

This is the part of the service that has been silently wrong twice: a subset
font maps characters through tables that are easy to reverse incorrectly, and
the failure mode is never an exception — it is a PDF that exports with the
wrong glyphs. Everything here runs offline against synthetic inputs.
"""

import io
import re
import shutil
from pathlib import Path

import main
import pymupdf
import pytest
from fontTools.ttLib import TTFont

LIBERATION = Path("/usr/share/fonts/liberation/LiberationSans-Regular.ttf")
LIBERATION_BOLD = Path("/usr/share/fonts/liberation/LiberationSans-Bold.ttf")
needs_liberation = pytest.mark.skipif(
    not LIBERATION.is_file(), reason="Liberation fonts not installed"
)


# --- ToUnicode parsing ---------------------------------------------------


def test_ligature_destination_is_dropped():
    """<00AA> <00660069> means "glyph 0xAA draws fi".

    Reversing it to f -> 0xAA makes every f render as "fi", so "file" exports
    as "fiile". A multi-character destination has no single-character inverse.
    """
    mapping = main.parse_tounicode(
        "2 beginbfchar\n<00AA> <00660069>\n<0025> <0066>\nendbfchar"
    )
    assert mapping[ord("f")] == 0x25
    assert 0xAA not in mapping.values()


def test_bfchar_and_contiguous_bfrange():
    mapping = main.parse_tounicode(
        "1 beginbfchar\n<0009> <0041>\nendbfchar\n"
        "1 beginbfrange\n<0030> <0032> <0061>\nendbfrange"
    )
    assert mapping[ord("A")] == 0x09
    assert [mapping[c] for c in map(ord, "abc")] == [0x30, 0x31, 0x32]


def test_bfrange_array_form():
    """The array form maps a range to non-contiguous destinations."""
    mapping = main.parse_tounicode(
        "1 beginbfrange\n<0040> <0042> [<0058> <0059> <005A>]\nendbfrange"
    )
    assert [mapping[c] for c in map(ord, "XYZ")] == [0x40, 0x41, 0x42]


def test_array_and_contiguous_bfrange_coexist():
    """An array entry must not be re-read as a run of contiguous triples."""
    mapping = main.parse_tounicode(
        "2 beginbfrange\n"
        "<0040> <0041> [<0058> <0059>]\n"
        "<0050> <0051> <0061>\n"
        "endbfrange"
    )
    assert mapping[ord("X")] == 0x40
    assert mapping[ord("a")] == 0x50
    assert mapping[ord("b")] == 0x51


def test_first_writer_wins():
    mapping = main.parse_tounicode(
        "2 beginbfchar\n<0005> <0041>\n<0009> <0041>\nendbfchar"
    )
    assert mapping[ord("A")] == 0x05


# --- cmap synthesis ------------------------------------------------------


def _strip_tables(path: Path, *tables: str) -> bytes:
    font = TTFont(path, fontNumber=0)
    for table in tables:
        if table in font:
            del font[table]
    buffer = io.BytesIO()
    font.save(buffer)
    return buffer.getvalue()


@needs_liberation
def test_synthesized_cmap_maps_characters_to_the_right_glyphs():
    original = TTFont(LIBERATION, fontNumber=0)
    order = original.getGlyphOrder()
    expected = {ch: order.index(original.getBestCmap()[ord(ch)]) for ch in "Ab7"}
    stripped = _strip_tables(LIBERATION, "cmap")

    patched = main._with_synthesized_cmap(
        stripped, {ord(ch): gid for ch, gid in expected.items()}
    )
    font = pymupdf.Font(fontbuffer=patched)
    for ch, gid in expected.items():
        assert font.has_glyph(ord(ch)) == gid


@needs_liberation
def test_post_table_is_added_for_browser_sanitizers():
    """Browsers reject a TrueType @font-face with no `post` table outright."""
    stripped = _strip_tables(LIBERATION, "cmap", "post")
    assert "post" not in TTFont(io.BytesIO(stripped), lazy=True)

    patched = main._with_synthesized_cmap(stripped, {ord("A"): 36})
    assert "post" in TTFont(io.BytesIO(patched), lazy=True)


@needs_liberation
def test_synthesis_refused_when_nothing_maps():
    assert main._with_synthesized_cmap(_strip_tables(LIBERATION, "cmap"), {}) is None


# --- guarding the code==glyph-id assumption ------------------------------


def _document_with_embedded_font(tmp_path: Path) -> tuple[pymupdf.Document, int]:
    """A PDF carrying a real Identity-H subset, as producers emit."""
    doc = pymupdf.open()
    page = doc.new_page()
    page.insert_text((72, 144), "Sample", fontfile=str(LIBERATION), fontname="F0")
    path = tmp_path / "embedded.pdf"
    doc.save(path)
    doc.close()
    reopened = pymupdf.open(path)
    xref = reopened[0].get_fonts(full=True)[0][0]
    return reopened, xref


def _descendant_xref(doc: pymupdf.Document, xref: int) -> int:
    """The CIDFont behind a Type0 font ("[10 0 R]" -> 10)."""
    return int(re.search(r"(\d+)\s+\d+\s+R", doc.xref_get_key(xref, "DescendantFonts")[1]).group(1))


@needs_liberation
def test_identity_cid_font_is_recognized(tmp_path):
    """Producers commonly omit /CIDToGIDMap, which the spec defines as
    Identity. PyMuPDF reports the absence as a truthy ("null", "null"), so a
    plain falsiness check silently rejects the most common shape."""
    doc, xref = _document_with_embedded_font(tmp_path)
    assert doc.xref_get_key(xref, "Encoding")[1] == "/Identity-H"
    descendant = _descendant_xref(doc, xref)
    assert doc.xref_get_key(descendant, "CIDToGIDMap")[0] == "null"
    assert main._maps_code_to_glyph_id(doc, xref) is True


@needs_liberation
def test_simple_font_is_refused(tmp_path):
    """A non-Type0 font maps codes through /Encoding, not to glyph ids.

    Synthesizing a cmap from its ToUnicode would point every character at the
    wrong glyph, so it must be rejected rather than guessed at.
    """
    doc, xref = _document_with_embedded_font(tmp_path)
    doc.xref_set_key(xref, "Subtype", "/TrueType")
    assert main._maps_code_to_glyph_id(doc, xref) is False


@needs_liberation
def test_cid_to_gid_map_stream_is_refused(tmp_path):
    """A CIDToGIDMap stream remaps CIDs explicitly: code != glyph id."""
    doc, xref = _document_with_embedded_font(tmp_path)
    doc.xref_set_key(_descendant_xref(doc, xref), "CIDToGIDMap", "999 0 R")
    assert main._maps_code_to_glyph_id(doc, xref) is False


# --- PostScript name parsing ---------------------------------------------


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("IUNIYH+Anton-Regular", ("Anton", False, False)),
        ("IBMPlexSans", ("IBM Plex Sans", False, False)),
        # Camel case splits SemiBold in two; the halves must glue back.
        ("IBMPlexSans-SemiBold", ("IBM Plex Sans", True, False)),
        # "Roman" belongs to the family here, it is not a weight.
        ("TimesNewRomanPSMT", ("Times New Roman", False, False)),
        ("Arial-BoldMT", ("Arial", True, False)),
        ("Helvetica-Oblique", ("Helvetica", False, True)),
        ("Roboto-BlackItalic", ("Roboto", True, True)),
        ("Montserrat-ExtraBold", ("Montserrat", True, False)),
    ],
)
def test_parse_font_name(name, expected):
    assert main.parse_font_name(name) == expected


# --- font library --------------------------------------------------------


@needs_liberation
def test_library_indexes_weight_and_slant_separately(tmp_path, monkeypatch):
    """Regular and Bold of one family must not collapse onto the same key.

    They share name id 1 ("Liberation Sans") and differ only in id 2, so
    reading the family alone files them together — and a bold lookup then
    silently returns the regular cut.
    """
    monkeypatch.setattr(main, "FONTS_DIR", tmp_path)
    monkeypatch.setattr(main, "_library_cache", None)
    shutil.copy(LIBERATION, tmp_path / "a.ttf")
    shutil.copy(LIBERATION_BOLD, tmp_path / "b.ttf")

    index = main.font_library_index()
    assert index[("liberationsans", False, False)].name == "a.ttf"
    assert index[("liberationsans", True, False)].name == "b.ttf"


@needs_liberation
def test_resolution_prefers_the_requested_weight(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "FONTS_DIR", tmp_path)
    monkeypatch.setattr(main, "_library_cache", None)
    monkeypatch.setattr(main, "FONT_DOWNLOAD_ENABLED", False)
    shutil.copy(LIBERATION, tmp_path / "a.ttf")
    shutil.copy(LIBERATION_BOLD, tmp_path / "b.ttf")

    assert main.resolve_family_file("LiberationSans", True, False)[0].name == "b.ttf"
    assert main.resolve_family_file("LiberationSans", False, False)[0].name == "a.ttf"


@needs_liberation
def test_upright_cut_is_the_last_resort(tmp_path, monkeypatch):
    """With downloads off and no italic on disk, the upright cut still wins
    over dropping to an unrelated family."""
    monkeypatch.setattr(main, "FONTS_DIR", tmp_path)
    monkeypatch.setattr(main, "_library_cache", None)
    monkeypatch.setattr(main, "FONT_DOWNLOAD_ENABLED", False)
    shutil.copy(LIBERATION, tmp_path / "a.ttf")

    assert main.resolve_family_file("LiberationSans", False, True)[0].name == "a.ttf"


def test_downloads_disabled_yields_nothing(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "FONTS_DIR", tmp_path)
    monkeypatch.setattr(main, "_library_cache", None)
    monkeypatch.setattr(main, "FONT_DOWNLOAD_ENABLED", False)
    assert main.resolve_family_file("Anton") is None


def test_library_cache_follows_directory_changes(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "FONTS_DIR", tmp_path)
    monkeypatch.setattr(main, "_library_cache", None)
    assert main.font_library_index() == {}
    if LIBERATION.is_file():
        shutil.copy(LIBERATION, tmp_path / "a.ttf")
        assert ("liberationsans", False, False) in main.font_library_index()


# --- coverage ------------------------------------------------------------


@needs_liberation
def test_whitespace_does_not_veto_coverage():
    """Subsets routinely omit the space glyph; TextWriter lays it out anyway."""
    font = pymupdf.Font(fontbuffer=main._with_synthesized_cmap(
        _strip_tables(LIBERATION, "cmap"), {ord("A"): 36}
    ))
    assert font.has_glyph(ord(" ")) == 0
    assert main.covers_text(font, "A A") is True
    assert main.covers_text(font, "AB") is False
