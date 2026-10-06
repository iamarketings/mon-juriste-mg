import unittest
from urllib.parse import parse_qs, urlsplit

from monjuris.source import CNLegisSource, SourceError, normalize_document, plain_text


def row(document_id, **changes):
    result = {
        "id": str(document_id), "type_txt": "Loi", "num_txt": "2024-014",
        "date_txt": "14-08-2024", "objet_txt": "<p>Portant Code du Travail</p>",
        "etat_txt": "En vigueur", "notes": "<p>Modifie l&#39;article 1.</p>",
        "html_fichier_fr": "<h1>LOI 2024-014</h1><p>Article 1. Disposition juridique.</p>",
        "html_fichier_mg": "", "version_pdf_fr": None, "version_pdf_mg": None,
    }
    result.update(changes)
    return result


class SessionClient:
    """Fixture that requires the same stateful sequence as the live site."""

    def __init__(self, *, clamp=None):
        self.requests = []
        self.selected = None
        self.clamp = clamp
        self.themes = {"DROIT CIVIL": ["672", "683"], "DROIT DU TRAVAIL": ["510"]}
        self.rows = {"672": [row(1), row(2), row(3)], "683": [row(2), row(4)], "510": [row(4), row(5)]}

    def get_text(self, url):
        self.requests.append(url)
        path = urlsplit(url).path
        if path == "/page_acces_theme/":
            return "".join(f'<a href="https://cnlegis.gov.mg/page_mots_cles_filter/{theme}/">{theme}</a>' for theme in self.themes)
        if path.startswith("/page_mots_cles_filter/"):
            from urllib.parse import unquote
            theme = unquote(path.split("/")[2])
            return "".join(f'<a href="/page_data_liste_docs_filter/{topic}/">Sous-thème {topic}</a>' for topic in self.themes[theme])
        if path.startswith("/page_data_liste_docs_filter/"):
            self.selected = path.split("/")[2]
            return f'<div id="total_enrg">{len(self.rows[self.selected])}&nbsp;résultat(s)</div><input id="page_limite" value="0,10">'
        raise AssertionError(url)

    def get_json(self, url):
        self.requests.append(url)
        if self.selected is None:
            raise AssertionError("JSON requested without selecting a session topic")
        offset, count = map(int, parse_qs(urlsplit(url).query)["var_pg_limit"][0].split(","))
        count = min(count, self.clamp) if self.clamp else count
        return {"aaData": self.rows[self.selected][offset:offset + count]}


class SourceTests(unittest.TestCase):
    def normalize(self, source_row, languages=None):
        return normalize_document(source_row, theme="DROIT DU TRAVAIL", topic_id="510", topic_label="Code du Travail", source_url="https://cnlegis.gov.mg/page_data_liste_docs_filter/510/", languages=languages or ["fr", "mg"])

    def test_latest_code_uses_pdf_link_even_when_pdf_column_is_null(self):
        fragment = '<p>LOI 2024-014</p><a href="https://cnlegis.gov.mg/uploads/L2024-014-VF.pdf">Cliquez-ici</a>'
        document = self.normalize(row(55500, html_fichier_fr=fragment))
        self.assertEqual(document["assets"], [{"language": "fr", "kind": "pdf", "url": "https://cnlegis.gov.mg/uploads/L2024-014-VF.pdf", "html": None}])
        self.assertEqual(document["date"], "14-08-2024")
        self.assertEqual(document["legal_status"], "En vigueur")
        self.assertNotIn("html_fichier_fr", document["metadata"]["raw"])
        self.assertNotIn("<p>", document["title"])

    def test_complete_html_and_metadata_only_rows_are_preserved(self):
        complete = row(3)
        document = self.normalize(complete)
        self.assertEqual(document["assets"][0]["html"], complete["html_fichier_fr"])
        document = self.normalize(row(4, html_fichier_fr="", etat_txt=None))
        self.assertEqual(document["assets"], [])
        self.assertEqual(document["legal_status"], "unknown")

    def test_legacy_pdf_filename_unicode_and_encoded_link(self):
        document = self.normalize(row(5, version_pdf_fr="Exp n° 2024-014-VF.pdf"))
        self.assertEqual(document["assets"][0]["url"], "https://cnlegis.gov.mg/jqupload_2/uploads/Exp%20n%C2%B0%202024-014-VF.pdf")
        document = self.normalize(row(6, html_fichier_fr='<a href="/uploads/L2024-014-VF.pdf">VF</a><a href="/uploads/L2024-014-VF.pdf">VF</a>', html_fichier_mg='<a href="/uploads/L2024-014-VM.pdf">VM</a>'))
        self.assertEqual(len(document["assets"]), 2)
        self.assertEqual([asset["language"] for asset in document["assets"]], ["fr", "mg"])

    def test_pdf_urls_never_follow_external_localhost_or_other_paths(self):
        for url in ["https://evil.example/x.pdf", "http://localhost/legisapplications/uploads/a.pdf", "https://cnlegis.gov.mg/private/a.pdf", "https://cnlegis.gov.mg/uploads/../private/a.pdf", "https://cnlegis.gov.mg:443/uploads/a.pdf", "https://x@cnlegis.gov.mg/uploads/a.pdf"]:
            with self.subTest(url=url):
                document = self.normalize(row(6, version_pdf_fr=url, html_fichier_fr=""))
                self.assertEqual(document["assets"], [])

    def test_pagination_traverses_children_and_keeps_duplicate_provenance(self):
        client = SessionClient()
        documents = list(CNLegisSource(client).discover({"themes": ["DROIT CIVIL", "DROIT DU TRAVAIL"], "page_size": 2}))
        self.assertEqual([document["source_id"] for document in documents], ["1", "2", "3", "2", "4", "4", "5"])
        self.assertEqual(documents[-2]["categories"], ["DROIT DU TRAVAIL"])
        self.assertEqual(documents[3]["metadata"]["topic_id"], "683")
        self.assertTrue(any("var_pg_limit=2%2C2" in request for request in client.requests))

    def test_clamped_pages_advance_by_actual_count_without_skipping(self):
        client = SessionClient(clamp=1)
        documents = list(CNLegisSource(client).discover({"themes": ["DROIT CIVIL"], "page_size": 50}))
        self.assertEqual([document["source_id"] for document in documents], ["1", "2", "3", "2", "4"])
        self.assertTrue(any("var_pg_limit=1%2C50" in request for request in client.requests))

    def test_unique_limit_stops_before_later_requests(self):
        client = SessionClient()
        documents = list(CNLegisSource(client).discover({"themes": ["DROIT CIVIL"], "page_size": 2}, limit=4))
        self.assertEqual([document["source_id"] for document in documents], ["1", "2", "3", "2", "4"])
        client = SessionClient()
        self.assertEqual(list(CNLegisSource(client).discover({"themes": ["DROIT CIVIL"]}, limit=0)), [])
        self.assertEqual(client.requests, [])

    def test_missing_theme_bad_rows_and_missing_total_fail_explicitly(self):
        with self.assertRaises(SourceError):
            list(CNLegisSource(SessionClient()).discover({"themes": ["UNEXPECTED"]}))
        client = SessionClient()
        client.get_json = lambda url: {"aaData": ""}
        with self.assertRaises(SourceError):
            list(CNLegisSource(client).discover({"themes": ["DROIT CIVIL"]}))
        with self.assertRaises(SourceError):
            self.normalize(row("invalid"))

    def test_repeated_page_is_rejected_instead_of_silently_skipping(self):
        client = SessionClient()
        client.get_json = lambda url: {"aaData": [row(1)]}
        with self.assertRaisesRegex(SourceError, "repeated a page"):
            list(CNLegisSource(client).discover({"themes": ["DROIT CIVIL"], "page_size": 1}))

    def test_scope_validation_and_plain_text_excludes_scripts(self):
        for scope in [{"themes": []}, {"themes": ["DROIT CIVIL"], "languages": ["en"]}, {"themes": ["DROIT CIVIL"], "page_size": 0}, {"themes": ["DROIT CIVIL"], "page_size": True}]:
            with self.subTest(scope=scope), self.assertRaises(ValueError):
                list(CNLegisSource(SessionClient()).discover(scope))
        self.assertEqual(plain_text('<p>L&#39;article</p><script>secret()</script><p>Deuxième</p>'), "L'article\nDeuxième")


if __name__ == "__main__":
    unittest.main()
