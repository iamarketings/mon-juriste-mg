"""Public CNLEGIS theme discovery and document normalization.

The JSON endpoint stores its selected sub-theme in the HTTP session. The client
must therefore retain cookies, and a source instance must not be used by several
concurrent discovery tasks.
"""

from __future__ import annotations

import html
import re
from collections.abc import Iterator, Mapping
from html.parser import HTMLParser
from typing import Any, Protocol
from urllib.parse import quote, unquote, urlencode, urljoin, urlsplit, urlunsplit


BASE_URL = "https://cnlegis.gov.mg/"
THEME_INDEX_URL = urljoin(BASE_URL, "page_acces_theme/")
ROWS_URL = urljoin(BASE_URL, "page_num_mot_cles_find_theme")


class SourceError(RuntimeError):
    """The public source did not match its expected discovery contract."""


class SourceClient(Protocol):
    """A synchronous HTTP client retaining the same cookies between calls."""

    def get_text(self, url: str) -> str: ...

    def get_json(self, url: str) -> dict[str, Any]: ...


class _TextParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.hidden: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"script", "style"}:
            self.hidden.append(tag)
        elif not self.hidden and tag in {"p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6"}:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if self.hidden:
            if tag == self.hidden[-1]:
                self.hidden.pop()
        elif tag in {"p", "div", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6"}:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not self.hidden:
            self.parts.append(data)


def plain_text(fragment: Any, *, single_line: bool = False) -> str:
    """Decode source HTML without executing it, retaining useful line breaks."""
    parser = _TextParser()
    parser.feed(str(fragment or ""))
    parser.close()
    text = html.unescape("".join(parser.parts))
    lines = [" ".join(line.split()) for line in text.splitlines()]
    text = "\n".join(line for line in lines if line)
    return " ".join(text.split()) if single_line else text


class _AnchorParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.anchors: list[tuple[str, str]] = []
        self.href: str | None = None
        self.parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "a":
            self.href = dict(attrs).get("href")
            self.parts = []

    def handle_data(self, data: str) -> None:
        if self.href is not None:
            self.parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == "a" and self.href is not None:
            self.anchors.append((self.href, " ".join("".join(self.parts).split())))
            self.href = None
            self.parts = []


def _anchors(fragment: str) -> list[tuple[str, str]]:
    parser = _AnchorParser()
    parser.feed(fragment)
    parser.close()
    return parser.anchors


def _public_url(reference: Any, *, base: str = BASE_URL) -> str | None:
    if not isinstance(reference, str) or not reference.strip():
        return None
    candidate = urlsplit(urljoin(base, html.unescape(reference.strip())))
    if (
        candidate.scheme not in {"http", "https"}
        or candidate.hostname not in {"cnlegis.gov.mg", "www.cnlegis.gov.mg"}
        or candidate.username is not None
        or candidate.password is not None
        or candidate.netloc.lower() not in {"cnlegis.gov.mg", "www.cnlegis.gov.mg"}
    ):
        return None
    path = quote(candidate.path, safe="/%:@!$&'()*+,;=-_.~")
    query = quote(candidate.query, safe="%=&?/:@!$'()*+,;~-_.")
    return urlunsplit(("https", "cnlegis.gov.mg", path, query, ""))


def _pdf_url(reference: Any, *, filename: bool = False) -> str | None:
    if not isinstance(reference, str) or not reference.strip():
        return None
    reference = reference.strip()
    if filename and not urlsplit(reference).scheme and not reference.startswith(("/", "//")):
        # The legacy PDF columns contain filenames in this public upload folder.
        reference = "jqupload_2/uploads/" + quote(unquote(reference), safe="-_.() ").replace(" ", "%20")
    url = _public_url(reference)
    if url is None:
        return None
    path = unquote(urlsplit(url).path)
    if not path.lower().endswith(".pdf"):
        return None
    if not path.startswith(("/uploads/", "/jqupload_2/uploads/")):
        return None
    # A filename may not escape the known public upload folders.
    if any(part == ".." for part in path.split("/")):
        return None
    return url


def _assets(row: Mapping[str, Any], languages: list[str]) -> list[dict[str, Any]]:
    assets: list[dict[str, Any]] = []
    for language in languages:
        fragment = str(row.get(f"html_fichier_{language}") or "")
        pdf_urls: list[str] = []
        legacy_pdf = _pdf_url(row.get(f"version_pdf_{language}"), filename=True)
        if legacy_pdf:
            pdf_urls.append(legacy_pdf)
        for href, _label in _anchors(fragment):
            pdf_url = _pdf_url(href)
            if pdf_url and pdf_url not in pdf_urls:
                pdf_urls.append(pdf_url)
        if pdf_urls:
            assets.extend(
                {"language": language, "kind": "pdf", "url": pdf_url, "html": None}
                for pdf_url in pdf_urls
            )
        elif plain_text(fragment):
            assets.append({"language": language, "kind": "html", "url": None, "html": fragment})
    return assets


def normalize_document(
    row: Mapping[str, Any], *, theme: str, topic_id: str, topic_label: str,
    source_url: str, languages: list[str],
) -> dict[str, Any]:
    """Keep CNLEGIS identities, versions, status and public source provenance."""
    source_id = str(row.get("id") or "").strip()
    if not source_id or not source_id.isdecimal():
        raise SourceError("CNLEGIS row has no valid document id")
    document_type = plain_text(row.get("type_txt"), single_line=True)
    number = plain_text(row.get("num_txt"), single_line=True)
    subject = plain_text(row.get("objet_txt") or row.get("objet_txt_mg"), single_line=True)
    reference = " ".join(part for part in (document_type, f"n° {number}" if number else "") if part)
    title = " — ".join(part for part in (reference, subject) if part) or f"Texte CNLEGIS {source_id}"
    return {
        "id": f"cnlegis:{source_id}",
        "source_id": source_id,
        "title": title,
        "type": document_type,
        "number": number,
        "date": row.get("date_txt") or "",
        "legal_status": plain_text(row.get("etat_txt"), single_line=True) or "unknown",
        "notes": plain_text(row.get("notes")),
        "categories": [theme],
        "source_url": source_url,
        "metadata": {
            "raw": {key: value for key, value in row.items() if not key.startswith("html_fichier_")},
            "sous_theme": topic_label,
            "topic_id": topic_id,
            "id": source_id,
            "num_jo": row.get("num_jo"),
            "date_jo": row.get("date_jo"),
            "page_jo": row.get("page_jo"),
            "notes_mg": plain_text(row.get("notes_mg")),
            "ministere": plain_text(row.get("ministere")),
        },
        "assets": _assets(row, languages),
    }


class CNLegisSource:
    def __init__(self, client: SourceClient) -> None:
        self.client = client

    def discover(self, scope: dict[str, Any], limit: int | None = None) -> Iterator[dict[str, Any]]:
        """Yield source rows with a limit on distinct CNLEGIS document IDs.

        The same ID can occur under several sub-themes. Such occurrences are
        deliberately yielded so the caller can merge all category provenance.
        A limited run stops early and cannot establish corpus completeness.
        """
        themes = scope.get("themes")
        languages = scope.get("languages", ["fr", "mg"])
        page_size = scope.get("page_size", 50)
        if not isinstance(themes, list) or not themes or any(not isinstance(item, str) or not item.strip() for item in themes):
            raise ValueError("scope.themes must be a non-empty list of exact CNLEGIS theme labels")
        if not isinstance(languages, list) or not languages or any(item not in {"fr", "mg"} for item in languages):
            raise ValueError("scope.languages must contain only 'fr' and/or 'mg'")
        if isinstance(page_size, bool) or not isinstance(page_size, int) or not 1 <= page_size <= 100:
            raise ValueError("scope.page_size must be an integer from 1 to 100")
        if limit is not None and (isinstance(limit, bool) or not isinstance(limit, int) or limit < 0):
            raise ValueError("limit must be a non-negative integer or None")
        if limit == 0:
            return
        languages = list(dict.fromkeys(languages))
        available: dict[str, str] = {}
        for href, label in _anchors(self.client.get_text(THEME_INDEX_URL)):
            url = _public_url(href)
            if url and urlsplit(url).path.startswith("/page_mots_cles_filter/"):
                available[label] = url
        missing = [theme for theme in themes if theme not in available]
        if missing:
            raise SourceError(f"CNLEGIS themes absent from public index: {', '.join(missing)}")

        seen_documents: set[str] = set()
        for theme in dict.fromkeys(themes):
            topics: dict[str, tuple[str, str]] = {}
            for href, label in _anchors(self.client.get_text(available[theme])):
                url = _public_url(href)
                match = re.fullmatch(r"/page_data_liste_docs_filter/(\d+)/?", urlsplit(url).path) if url else None
                if match:
                    topics[match.group(1)] = (label, url)
            if not topics:
                raise SourceError(f"CNLEGIS theme has no public sub-theme links: {theme}")
            for topic_id, (topic_label, listing_url) in topics.items():
                # This request is required even if the listing is already cached:
                # it selects the sub-theme in the current cookie session.
                listing = self.client.get_text(listing_url)
                text = plain_text(listing, single_line=True)
                match = re.search(r"(\d[\d\s]*)\s*r[ée]sultat\(s\)", text, re.IGNORECASE)
                if not match:
                    raise SourceError(f"Missing CNLEGIS result count at {listing_url}")
                total = int(re.sub(r"\s", "", match.group(1)))
                offset = 0
                previous_page_ids: tuple[str, ...] | None = None
                while offset < total:
                    payload = self.client.get_json(ROWS_URL + "?" + urlencode({"var_pg_limit": f"{offset},{page_size}"}))
                    rows = payload.get("aaData") if isinstance(payload, dict) else None
                    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
                        raise SourceError(f"Invalid CNLEGIS aaData for sub-theme {topic_id} at offset {offset}")
                    if not rows or len(rows) > page_size or offset + len(rows) > total:
                        raise SourceError(f"Unexpected CNLEGIS page size for sub-theme {topic_id}: offset={offset}, rows={len(rows)}, total={total}")
                    page_ids = tuple(str(row.get("id")) for row in rows)
                    if page_ids == previous_page_ids:
                        raise SourceError(f"CNLEGIS repeated a page for sub-theme {topic_id}; session or pagination may be invalid")
                    previous_page_ids = page_ids
                    for row in rows:
                        document = normalize_document(row, theme=theme, topic_id=topic_id, topic_label=topic_label, source_url=listing_url, languages=languages)
                        seen_documents.add(document["id"])
                        yield document
                        if limit is not None and len(seen_documents) >= limit:
                            return
                    # Some servers clamp the requested count. Advancing by the
                    # actual row count avoids silently skipping documents.
                    offset += len(rows)
