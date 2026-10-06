import unittest
from monjuris.http import check_url, PoliteClient


class HttpBoundaryTests(unittest.TestCase):
    def test_sources_are_restricted(self):
        for url in ("https://cnlegis.gov.mg/uploads/test.pdf", "https://www.cnlegis.gov.mg/page/"):
            check_url(url)
        for url in ("http://localhost/legisapplications/page_lien/1", "https://example.com/x",
                    "https://cnlegis.gov.mg.evil.test/x", "https://cnlegis.gov.mg:9999/", "file:///C:/secret"):
            with self.assertRaises(ValueError):
                check_url(url)

    def test_bad_limits_are_rejected(self):
        with self.assertRaises(ValueError):
            PoliteClient(delay=-1)


if __name__ == "__main__":
    unittest.main()
