import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from monjuris.extract import chunk_pages, extract_document, ocr_document


LEGAL_TEXT = "Article premier. La présente loi régit les relations entre employeurs et salariés dans les entreprises de Madagascar."


class ExtractionTests(unittest.TestCase):
    def pdf_result(self, page_texts):
        reader = SimpleNamespace(
            is_encrypted=False,
            pages=[SimpleNamespace(extract_text=lambda text=text: text) for text in page_texts],
        )
        with patch("monjuris.extract.PdfReader", return_value=reader):
            return extract_document(Path("fixture.pdf"), "pdf")

    def html_result(self, html):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.html"
            path.write_text(html, encoding="utf-8")
            return extract_document(path, "html")

    def test_mixed_text_and_scan_requires_review_and_preserves_page_numbers(self):
        result = self.pdf_result([LEGAL_TEXT, None, LEGAL_TEXT])
        self.assertEqual("partial", result["status"])
        self.assertEqual(3, result["page_count"])
        self.assertEqual([1, 2, 3], [page["page"] for page in result["pages"]])
        self.assertEqual("", result["pages"][1]["text"])
        self.assertTrue(any("Page 2" in warning for warning in result["warnings"]))

    def test_scans_and_title_only_pages_are_not_ready(self):
        self.assertEqual("needs_ocr", self.pdf_result([None, "7", "CODE DU TRAVAIL"])["status"])
        self.assertEqual("empty", self.pdf_result([])["status"])

    def test_text_pdf_ready_and_character_count(self):
        result = self.pdf_result([LEGAL_TEXT, LEGAL_TEXT])
        self.assertEqual("ready", result["status"])
        self.assertEqual(2 * len(LEGAL_TEXT), result["text_chars"])

    def test_failed_page_extraction_is_never_complete(self):
        def bad_page():
            raise ValueError("broken content")

        reader = SimpleNamespace(is_encrypted=False, pages=[SimpleNamespace(extract_text=bad_page)])
        with patch("monjuris.extract.PdfReader", return_value=reader):
            result = extract_document(Path("fixture.pdf"), "pdf")
        self.assertEqual("error", result["status"])
        self.assertEqual(1, result["page_count"])

    def test_html_document_keeps_articles_and_drops_site_navigation(self):
        html = f"<html><nav>Accueil CONTACT NOISE</nav><main><h1>Loi portant code du travail</h1><p>{LEGAL_TEXT}</p><p>Art. <b>2</b>. Tous les salariés sont protégés par les dispositions de cette loi.</p></main><footer>FOOTER NOISE</footer><script>secret()</script></html>"
        result = self.html_result(html)
        self.assertEqual("ready", result["status"])
        self.assertNotIn("NOISE", result["pages"][0]["text"])
        self.assertNotIn("secret", result["pages"][0]["text"])
        chunks = chunk_pages(result["pages"])
        self.assertEqual([None, "Article premier", "Article 2"], [chunk["article"] for chunk in chunks])

    def test_html_error_login_and_listing_are_not_documents(self):
        self.assertEqual("error", self.html_result("<title>Erreur 404</title><p>Texte introuvable</p>")["status"])
        self.assertEqual("error", self.html_result("<form><input type='password'>Connexion</form>")["status"])
        listing = "<h1>Code civil</h1><table id='Lst_docs'>" + "<tr><td><a href='/doc'>Loi sur les sociétés commerciales Madagascar</a></td></tr>" * 20 + "</table>"
        result = self.html_result(listing)
        self.assertEqual("empty", result["status"])
        self.assertEqual([], result["pages"])
        self.assertEqual(0, result["text_chars"])

    def test_linked_article_titles_in_a_listing_do_not_masquerade_as_full_text(self):
        html = "<main><table id='Lst_docs'>" + "<tr><td><a href='/doc'>Article 1. Texte concernant les entreprises et le code du travail.</a></td></tr>" * 20 + "</table></main>"
        self.assertEqual("empty", self.html_result(html)["status"])

    def test_reader_wrapper_is_not_a_document(self):
        self.assertEqual("empty", self.html_result("<h1>Code du travail</h1><iframe src='code.pdf'></iframe>")["status"])


class OcrTests(unittest.TestCase):
    def native_result(self, texts, status="partial"):
        return {
            "status": status,
            "pages": [{"page": index + 1, "text": text} for index, text in enumerate(texts)],
            "page_count": len(texts),
            "text_chars": sum(map(len, texts)),
            "warnings": [],
        }

    def test_missing_binary_keeps_document_incomplete_with_actionable_diagnostic(self):
        with patch("monjuris.extract.extract_document", return_value=self.native_result([LEGAL_TEXT, ""])), patch("monjuris.extract.shutil.which", return_value=None), patch("monjuris.extract.subprocess.run") as run:
            result = ocr_document(Path("fixture.pdf"))
        self.assertEqual("partial", result["status"])
        self.assertIn("PATH", result["warnings"][-1])
        self.assertEqual(LEGAL_TEXT, result["pages"][0]["text"])
        run.assert_not_called()

    def test_native_ready_document_never_calls_ocr(self):
        with patch("monjuris.extract.extract_document", return_value=self.native_result([LEGAL_TEXT], "ready")), patch("monjuris.extract.shutil.which") as which:
            self.assertEqual("ready", ocr_document(Path("fixture.pdf"))["status"])
        which.assert_not_called()

    def test_missing_renderer_is_a_diagnostic_not_a_network_fallback(self):
        with patch("monjuris.extract.extract_document", return_value=self.native_result([""], "needs_ocr")), patch("monjuris.extract.shutil.which", return_value="tesseract"), patch("monjuris.extract.import_module", side_effect=ImportError):
            result = ocr_document(Path("fixture.pdf"))
        self.assertEqual("needs_ocr", result["status"])
        self.assertIn("pypdfium2", result["warnings"][-1])

    def test_ocr_only_renders_weak_pages_and_preserves_native_text(self):
        rendered = []

        class Image:
            def save(self, path):
                path.write_bytes(b"synthetic image fixture")

            def close(self):
                pass

        class Document:
            def __len__(self):
                return 2

            def __getitem__(self, index):
                rendered.append(index)
                return SimpleNamespace(render=lambda scale: SimpleNamespace(to_pil=Image))

            def close(self):
                pass

        fake_pdfium = SimpleNamespace(PdfDocument=lambda path: Document())
        process = SimpleNamespace(returncode=0, stdout=LEGAL_TEXT + " Texte reconnu.", stderr="")
        with patch("monjuris.extract.extract_document", return_value=self.native_result([LEGAL_TEXT, ""])), patch("monjuris.extract.shutil.which", return_value="tesseract"), patch("monjuris.extract.import_module", return_value=fake_pdfium), patch("monjuris.extract.subprocess.run", return_value=process) as run:
            result = ocr_document(Path("fixture.pdf"), languages="fra+eng")
        self.assertEqual("ready", result["status"])
        self.assertEqual([1], rendered)
        self.assertEqual(LEGAL_TEXT, result["pages"][0]["text"])
        self.assertTrue(result["pages"][1]["text"].endswith("Texte reconnu."))
        self.assertIn("fra+eng", run.call_args.args[0])
        self.assertFalse(run.call_args.kwargs.get("shell", False))

    def test_weak_ocr_and_missing_language_data_never_claim_ready(self):
        image = SimpleNamespace(save=lambda path: path.write_bytes(b"fixture"))
        document = [SimpleNamespace(render=lambda scale: SimpleNamespace(to_pil=lambda: image))]
        fake_pdfium = SimpleNamespace(PdfDocument=lambda path: document)
        for process in [SimpleNamespace(returncode=0, stdout="CODE", stderr=""), SimpleNamespace(returncode=1, stdout="", stderr="Failed loading language fra")]:
            with self.subTest(returncode=process.returncode), patch("monjuris.extract.extract_document", return_value=self.native_result([""], "needs_ocr")), patch("monjuris.extract.shutil.which", return_value="tesseract"), patch("monjuris.extract.import_module", return_value=fake_pdfium), patch("monjuris.extract.subprocess.run", return_value=process):
                result = ocr_document(Path("fixture.pdf"))
            self.assertEqual("needs_ocr", result["status"])
            self.assertTrue(result["warnings"])

    def test_invalid_ocr_settings(self):
        with self.assertRaises(ValueError):
            ocr_document(Path("fixture.pdf"), dpi=10)
        with self.assertRaises(ValueError):
            ocr_document(Path("fixture.pdf"), languages="fra --outputbase evil")


class ChunkTests(unittest.TestCase):
    def test_article_across_pages_keeps_preamble_and_page_attribution(self):
        pages = [
            {"page": 1, "text": "Préambule de la loi.\nArticle 1. La loi vise toutes les entreprises."},
            {"page": 2, "text": "Elle protège tous les travailleurs.\nArt. 2 bis. Chaque contrat doit respecter les règles."},
        ]
        chunks = chunk_pages(pages)
        self.assertEqual([None, "Article 1", "Article 2 bis"], [chunk["article"] for chunk in chunks])
        self.assertEqual((1, 2), (chunks[1]["page_start"], chunks[1]["page_end"]))
        self.assertNotIn("Art. 2", chunks[1]["text"])
        self.assertEqual((2, 2), (chunks[2]["page_start"], chunks[2]["page_end"]))

    def test_long_article_is_split_with_overlap_and_limit(self):
        text = "Article 12.\n" + "Obligations légales de chaque employeur. " * 30
        chunks = chunk_pages([{"page": 7, "text": text}], max_chars=180, overlap_chars=30)
        self.assertGreater(len(chunks), 3)
        self.assertTrue(all(len(chunk["text"]) <= 180 for chunk in chunks))
        self.assertTrue(all(chunk["article"] == "Article 12" for chunk in chunks))
        self.assertTrue(all(chunk["page_start"] == chunk["page_end"] == 7 for chunk in chunks))
        self.assertEqual(list(range(1, len(chunks) + 1)), [chunk["ordinal"] for chunk in chunks])
        # Check exact overlap for the first split without reusing split internals.
        self.assertTrue(any(chunks[0]["text"].endswith(chunks[1]["text"][:length]) for length in range(20, 31)))
        self.assertEqual(chunks, chunk_pages([{"page": 7, "text": text}], max_chars=180, overlap_chars=30))

    def test_chunk_ranges_do_not_include_an_empty_scan_page(self):
        chunks = chunk_pages([{"page": 1, "text": "Article 1. Première règle."}, {"page": 2, "text": ""}, {"page": 3, "text": "Article 2. Deuxième règle."}])
        self.assertEqual([(1, 1), (3, 3)], [(chunk["page_start"], chunk["page_end"]) for chunk in chunks])

    def test_inline_article_references_do_not_start_new_chunks(self):
        chunks = chunk_pages([{"page": 1, "text": "Article 1. Les conditions prévues à l'article 2 demeurent applicables.\nArticle 2. Autres règles."}])
        self.assertEqual(["Article 1", "Article 2"], [chunk["article"] for chunk in chunks])

    def test_alphanumeric_ids_and_unbroken_tokens(self):
        chunks = chunk_pages([{"page": 1, "text": "Article L. 123-2. Champ.\nArticle 12A.\n" + "x" * 300}], max_chars=100, overlap_chars=10)
        self.assertEqual("Article L. 123-2", chunks[0]["article"])
        self.assertTrue(all(chunk["article"] == "Article 12A" for chunk in chunks[1:]))
        self.assertTrue(all(len(chunk["text"]) <= 100 for chunk in chunks))

    def test_empty_and_invalid_settings(self):
        self.assertEqual([], chunk_pages([]))
        with self.assertRaises(ValueError):
            chunk_pages([], max_chars=100, overlap_chars=100)
        with self.assertRaises(ValueError):
            chunk_pages([], max_chars=0)


if __name__ == "__main__":
    unittest.main()
