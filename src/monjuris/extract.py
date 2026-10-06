"""Conservative text extraction and article-aware chunks for legal documents.

``ready`` means every PDF page passed a basic text-coverage check.  It does
not assert that a text is in force, consolidated, or free from OCR mistakes.
Empty and weak PDF pages are kept in the result so they cannot silently vanish
from the corpus or change the page numbers used in citations.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import tempfile
from importlib import import_module
from pathlib import Path
from typing import Any

from bs4 import BeautifulSoup
from pypdf import PdfReader


_ARTICLE_RE = re.compile(
    r"(?im)^[ \t]*(?:article|art\.)[ \t\n]*"
    r"(?P<number>premi(?:er|ère|ere)|unique|"
    r"(?:[LRDA]\.[ \t]*)?\d+(?:[.\-]\d+)*"
    r"(?:er|ère|ere|re|ème|eme|e)?"
    r"(?:[ \t]*(?:bis|ter|quater|quinquies|sexies|septies|octies|nonies|decies)"
    r"|[A-Za-z](?![A-Za-z])|[ \t]+[A-Z](?=[ \t]*[.:—–\-]|[ \t]*$))?)"
    r"(?![\w])"
)
_ERROR_TITLE_RE = re.compile(
    r"(?:^|\b)(?:404|403|500|502|503|access denied|accès refusé|"
    r"forbidden|not found|page introuvable|service unavailable|"
    r"erreur serveur|server error|error\s*\d{3}|erreur\s*\d{3})(?:\b|$)",
    re.I,
)


def _normalise_text(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = text.replace("\x00", "").replace("\u00a0", " ")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def _result(status: str, pages: list[dict], warnings: list[str]) -> dict:
    return {
        "status": status,
        "pages": pages,
        "page_count": len(pages),
        "text_chars": sum(len(page["text"]) for page in pages),
        "warnings": warnings,
    }


def _substantial_page(text: str) -> bool:
    """A running title or a page number alone is not an extracted page."""
    return sum(char.isalnum() for char in text) >= 60 and len(text.split()) >= 8


def _extract_pdf(path: Path) -> dict:
    reader = PdfReader(str(path))
    if reader.is_encrypted and not reader.decrypt(""):
        return _result("error", [], ["PDF chiffré : mot de passe requis."])

    pages: list[dict] = []
    warnings: list[str] = []
    substantial = 0
    failures = 0
    for number, page in enumerate(reader.pages, 1):
        try:
            text = _normalise_text(page.extract_text() or "")
        except Exception as exc:
            failures += 1
            text = ""
            warnings.append(f"Page {number} : extraction impossible ({type(exc).__name__}).")
        pages.append({"page": number, "text": text})
        if _substantial_page(text):
            substantial += 1
        else:
            warnings.append(f"Page {number} : texte absent ou très faible ; OCR ou contrôle requis.")

    if not pages:
        return _result("empty", pages, ["PDF sans pages."])
    if failures == len(pages):
        status = "error"
    elif substantial == 0:
        status = "needs_ocr"
    elif substantial < len(pages):
        status = "partial"
    else:
        status = "ready"
    return _result(status, pages, warnings)


def _html_text(node: Any) -> str:
    """Keep block boundaries but avoid breaking article IDs across inline tags."""
    copy = BeautifulSoup(str(node), "html.parser")
    for tag in copy.find_all(["p", "div", "section", "article", "main", "h1", "h2", "h3", "h4", "h5", "h6", "li", "tr"]):
        tag.insert_before("\n")
        tag.insert_after("\n")
    for tag in copy.find_all("br"):
        tag.replace_with("\n")
    return _normalise_text(copy.get_text(" ", strip=False))


def _extract_html(path: Path) -> dict:
    soup = BeautifulSoup(path.read_bytes(), "html.parser")
    title = soup.title.get_text(" ", strip=True) if soup.title else ""
    heading = soup.find(["h1", "h2"])
    first_heading = heading.get_text(" ", strip=True) if heading else ""
    if _ERROR_TITLE_RE.search(title) or _ERROR_TITLE_RE.search(first_heading):
        return _result("error", [], ["Page HTML d'erreur ou d'accès refusé."])
    password_form = soup.find("input", attrs={"type": re.compile("^password$", re.I)}) is not None
    listing_table = soup.select_one("#Lst_docs, .dataTables_wrapper, table[data-datatable]") is not None

    for tag in soup.find_all(["script", "style", "noscript", "nav", "header", "footer", "aside", "form", "button", "input", "select", "textarea", "iframe", "object", "embed"]):
        tag.decompose()
    for tag in list(soup.select('[hidden], [aria-hidden="true"], .breadcrumb, .pagination, .cookie-banner')):
        if tag.parent is not None:
            tag.decompose()

    # Prefer a substantive legal body to a site wrapper, including pages whose
    # legal text is held in a modal or a document-specific content container.
    candidates = soup.select("main, article, .legal-text, .document-content, .contents-fr, #content")
    candidate_texts = [(_html_text(node), node) for node in candidates]
    legal_candidates = [pair for pair in candidate_texts if _ARTICLE_RE.search(pair[0])]
    if legal_candidates:
        text, node = max(legal_candidates, key=lambda pair: len(pair[0]))
    else:
        node = soup.body or soup
        text = _html_text(node)

    article_count = len(list(_ARTICLE_RE.finditer(text)))
    link_chars = sum(len(link.get_text(" ", strip=True)) for link in node.find_all("a"))
    link_count = len(node.find_all("a"))
    link_listing = link_count >= 3 and link_chars / max(len(text), 1) > 0.30
    known_listing = listing_table and node.select_one("#Lst_docs, .dataTables_wrapper, table[data-datatable]") is not None
    if known_listing or link_listing:
        return _result("empty", [], ["Page HTML de liste ou de navigation ; pas un document juridique."])
    if password_form and not article_count:
        return _result("error", [], ["Page de connexion HTML ; aucun texte juridique extrait."])
    legal_prose = (
        len(text) >= 500
        and len(text.split()) >= 70
        and re.search(r"\b(?:loi|décret|decret|ordonnance|code|arrêté|arrete)\b", text, re.I)
    )
    if not _substantial_page(text) or (not article_count and not legal_prose):
        return _result("empty", [], ["HTML sans texte juridique substantiel (habillage, aperçu ou lecteur PDF)."])
    return _result("ready", [{"page": 1, "text": text}], [])


def extract_document(path: Path, kind: str) -> dict:
    """Extract a local PDF or HTML file without silently completing scans.

    HTML has one logical page; its page number is not a printed PDF page.
    Unsupported kinds raise ``ValueError``.  File/parser failures return an
    ``error`` result containing a diagnostic without a traceback.
    """
    if kind not in {"pdf", "html"}:
        raise ValueError(f"Unsupported document kind: {kind!r}")
    try:
        return _extract_pdf(Path(path)) if kind == "pdf" else _extract_html(Path(path))
    except Exception as exc:
        return _result("error", [], [f"Extraction impossible ({type(exc).__name__}) : {exc}"])


def ocr_document(path: Path, languages: str = "fra", dpi: int = 180) -> dict:
    """Use local Tesseract only on PDF pages with weak native extraction.

    No model, API, network call, or paid service is used.  This optional path
    requires the ``pypdfium2`` and ``Pillow`` Python packages plus a Tesseract
    executable and its requested language data installed on the machine.
    Native text on substantive pages is preserved verbatim.  Missing tools
    and failed OCR leave the document incomplete with an explicit warning.
    """
    if not isinstance(dpi, int) or not 72 <= dpi <= 600:
        raise ValueError("dpi must be an integer between 72 and 600")
    if not re.fullmatch(r"[A-Za-z0-9_]+(?:\+[A-Za-z0-9_]+)*", languages):
        raise ValueError("languages must contain Tesseract language IDs, e.g. 'fra' or 'fra+eng'")

    native = extract_document(Path(path), "pdf")
    if native["status"] == "ready" or not native["pages"]:
        return native
    executable = shutil.which("tesseract")
    if not executable:
        native["warnings"].append("OCR local indisponible : installer Tesseract et les données de langue, puis ajouter tesseract au PATH.")
        return native
    try:
        pdfium = import_module("pypdfium2")
    except ImportError:
        native["warnings"].append("OCR local indisponible : installer les dépendances optionnelles pypdfium2 et Pillow (pip install '.[ocr]').")
        return native

    pages = [dict(page) for page in native["pages"]]
    warnings = list(native["warnings"])
    document = None
    try:
        document = pdfium.PdfDocument(str(path))
        if len(document) != len(pages):
            warnings.append("OCR interrompu : les extracteurs ne concordent pas sur le nombre de pages.")
            return _result(native["status"], pages, warnings)
        with tempfile.TemporaryDirectory(prefix="monjuris-ocr-") as directory:
            for index, page_record in enumerate(pages):
                if _substantial_page(page_record["text"]):
                    continue
                pdf_page = bitmap = image = None
                try:
                    pdf_page = document[index]
                    bitmap = pdf_page.render(scale=dpi / 72)
                    image = bitmap.to_pil()
                    image_path = Path(directory) / "page.png"
                    image.save(image_path)
                    process = subprocess.run(
                        [executable, str(image_path), "stdout", "-l", languages, "--dpi", str(dpi)],
                        capture_output=True,
                        encoding="utf-8",
                        errors="replace",
                        timeout=120,
                        check=False,
                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                    )
                    if process.returncode:
                        diagnostic = " ".join(process.stderr.strip().split())[:500]
                        warnings.append(f"Page {page_record['page']} : échec Tesseract (code {process.returncode}) : {diagnostic}")
                        continue
                    recognised = _normalise_text(process.stdout)
                    if not _substantial_page(recognised):
                        warnings.append(f"Page {page_record['page']} : OCR très faible ; contrôle manuel requis.")
                        continue
                    page_record["text"] = recognised
                    prefix = f"Page {page_record['page']} :"
                    warnings = [warning for warning in warnings if not warning.startswith(prefix)]
                    warnings.append(f"Page {page_record['page']} : texte obtenu par OCR local Tesseract ({languages}, {dpi} dpi) ; exactitude à vérifier.")
                except ImportError:
                    warnings.append("OCR local indisponible : installer Pillow (pip install '.[ocr]').")
                    break
                except Exception as exc:
                    warnings.append(f"Page {page_record['page']} : OCR impossible ({type(exc).__name__}) : {exc}")
                finally:
                    for resource in (image, bitmap, pdf_page):
                        if resource is not None and hasattr(resource, "close"):
                            resource.close()
    except Exception as exc:
        warnings.append(f"OCR impossible ({type(exc).__name__}) : {exc}")
    finally:
        if document is not None and hasattr(document, "close"):
            document.close()

    substantial = sum(_substantial_page(page["text"]) for page in pages)
    status = "ready" if substantial == len(pages) else "partial" if substantial else "needs_ocr"
    return _result(status, pages, warnings)


def _split_ranges(text: str, start: int, end: int, max_chars: int, overlap_chars: int):
    position = start
    while position < end:
        stop = min(position + max_chars, end)
        if stop < end:
            minimum = position + max_chars // 2
            # Split on a paragraph, a line, or a word boundary where possible.
            for separator in ("\n\n", "\n", " "):
                boundary = text.rfind(separator, minimum, stop)
                if boundary >= minimum:
                    stop = boundary + len(separator)
                    break
        actual_start = position
        actual_stop = stop
        while actual_start < actual_stop and text[actual_start].isspace():
            actual_start += 1
        while actual_stop > actual_start and text[actual_stop - 1].isspace():
            actual_stop -= 1
        if actual_stop > actual_start:
            yield actual_start, actual_stop
        if stop >= end:
            break
        position = max(position + 1, stop - overlap_chars)


def chunk_pages(pages: list[dict], *, max_chars: int = 1800, overlap_chars: int = 200) -> list[dict]:
    """Split text around article headings and retain exact source page ranges.

    Ordinals are one-based and deterministic.  The overlap is confined to the
    same article (or preamble).  Empty PDF pages keep their original numbers
    but do not acquire chunks.  Character limits are hard limits, including
    for a single unusually long word or article.
    """
    if max_chars < 1:
        raise ValueError("max_chars must be positive")
    if not 0 <= overlap_chars < max_chars:
        raise ValueError("overlap_chars must be nonnegative and smaller than max_chars")

    parts: list[str] = []
    page_spans: list[tuple[int, int, int]] = []
    cursor = 0
    for page in pages:
        text = _normalise_text(page.get("text", ""))
        if not text:
            continue
        if parts:
            parts.append("\n\n")
            cursor += 2
        page_spans.append((cursor, cursor + len(text), int(page["page"])))
        parts.append(text)
        cursor += len(text)
    text = "".join(parts)
    if not text:
        return []

    headings = list(_ARTICLE_RE.finditer(text))
    sections: list[tuple[int, int, str | None]] = []
    if not headings:
        sections.append((0, len(text), None))
    else:
        if headings[0].start() > 0:
            sections.append((0, headings[0].start(), None))
        for index, heading in enumerate(headings):
            end = headings[index + 1].start() if index + 1 < len(headings) else len(text)
            article = "Article " + re.sub(r"\s+", " ", heading.group("number")).strip()
            sections.append((heading.start(), end, article))

    chunks: list[dict] = []
    for start, end, article in sections:
        for left, right in _split_ranges(text, start, end, max_chars, overlap_chars):
            source_pages = [number for page_left, page_right, number in page_spans if page_left < right and page_right > left]
            chunks.append({
                "ordinal": len(chunks) + 1,
                "text": text[left:right],
                "page_start": source_pages[0],
                "page_end": source_pages[-1],
                "article": article,
            })
    return chunks
