"""Client sérialisé : le catalogue CNLEGIS dépend du cookie de session."""
from __future__ import annotations

import logging
import time
from urllib.parse import urlsplit, urljoin
from urllib.robotparser import RobotFileParser

import requests

LOG = logging.getLogger(__name__)
USER_AGENT = "MonJurisCollect/0.1 (public legal corpus; sequential requests)"
ALLOWED_HOSTS = {"cnlegis.gov.mg", "www.cnlegis.gov.mg"}


def check_url(url: str) -> None:
    parts = urlsplit(url)
    if (parts.scheme != "https" or parts.hostname not in ALLOWED_HOSTS
            or parts.username or parts.password or parts.port not in (None, 443)):
        raise ValueError(f"URL hors de la source publique autorisée : {url}")


class PoliteClient:
    def __init__(self, *, delay: float = 1.5, timeout: float = 30,
                 max_download_mb: int = 50):
        if delay < 0 or timeout <= 0 or max_download_mb <= 0:
            raise ValueError("Paramètres HTTP invalides")
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": USER_AGENT})
        self.delay = delay
        self.timeout = timeout
        self.max_bytes = max_download_mb * 1024 * 1024
        self._last_request = 0.0
        self._robots: dict[str, RobotFileParser] = {}

    def close(self):
        self.session.close()

    def _request(self, url: str, *, check_robots: bool = True) -> bytes:
        check_url(url)
        if check_robots:
            self._check_robots(url)
        for attempt in range(4):
            retry_delay = 0.0
            try:
                current = url
                for redirect in range(6):
                    check_url(current)
                    if check_robots:
                        self._check_robots(current)
                    wait = self.delay - (time.monotonic() - self._last_request)
                    if wait > 0:
                        time.sleep(wait)
                    self._last_request = time.monotonic()
                    LOG.debug("GET %s", current)
                    with self.session.get(current, timeout=self.timeout, stream=True,
                                          allow_redirects=False) as response:
                        if response.is_redirect:
                            current = urljoin(current, response.headers["Location"])
                            continue
                        if response.status_code == 429 or response.status_code >= 500:
                            try:
                                retry_delay = min(30.0, float(response.headers.get("Retry-After", 0)))
                            except ValueError:
                                pass
                            response.raise_for_status()
                        response.raise_for_status()
                        size = 0
                        chunks = []
                        for chunk in response.iter_content(65536):
                            size += len(chunk)
                            if size > self.max_bytes:
                                raise ValueError(f"Fichier supérieur à {self.max_bytes} octets : {url}")
                            chunks.append(chunk)
                        return b"".join(chunks)
                raise ValueError(f"Trop de redirections : {url}")
            except requests.RequestException as exc:
                code = exc.response.status_code if exc.response is not None else None
                if code is not None and code < 500 and code != 429:
                    raise
                if attempt == 3:
                    raise
                time.sleep(max(retry_delay, 2 ** attempt))
        raise RuntimeError("HTTP retry exhausted")

    def _check_robots(self, url: str):
        parts = urlsplit(url)
        origin = f"https://{parts.netloc}"
        if origin not in self._robots:
            parser = RobotFileParser(f"{origin}/robots.txt")
            try:
                body = self._request(parser.url, check_robots=False).decode("utf-8-sig")
            except requests.HTTPError as exc:
                if exc.response is not None and exc.response.status_code == 404:
                    body = "User-agent: *\nDisallow:\n"
                else:
                    raise
            parser.parse(body.splitlines())
            self._robots[origin] = parser
            crawl_delay = parser.crawl_delay(USER_AGENT) or parser.crawl_delay("*")
            if crawl_delay:
                self.delay = max(self.delay, float(crawl_delay))
        if not self._robots[origin].can_fetch(USER_AGENT, url):
            raise PermissionError(f"Accès interdit par robots.txt : {url}")

    def get_bytes(self, url: str) -> bytes:
        return self._request(url)

    def get_text(self, url: str) -> str:
        # CNLEGIS envoie parfois un charset HTTP erroné. Ne pas utiliser response.text.
        return self.get_bytes(url).decode("utf-8-sig")

    def get_json(self, url: str) -> dict:
        import json
        return json.loads(self.get_text(url))
