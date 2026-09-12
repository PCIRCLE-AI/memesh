"""Minimal stand-in for `httpx`, backed by urllib, for the Hermes contract test.

It implements only what extensions/hermes-memesh calls — `Client(base_url,
timeout)`, `.post(path, json=...)`, `.close()`, and a response with
`.status_code`, `.json()` and `.raise_for_status()` — and it sends REAL HTTP
requests to a real `memesh serve`. The stub stands in for the library, not
for the server: the envelope under test is the server's own.
"""

import json as _json
import urllib.error
import urllib.request


class HTTPStatusError(Exception):
    pass


class Response:
    def __init__(self, status_code, body):
        self.status_code = status_code
        self._body = body

    def json(self):
        return _json.loads(self._body)

    def raise_for_status(self):
        if self.status_code >= 400:
            raise HTTPStatusError(f"HTTP {self.status_code}: {self._body[:200]}")


class Client:
    def __init__(self, base_url="", timeout=5.0):
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout

    def post(self, path, json=None):
        data = _json.dumps(json if json is not None else {}).encode("utf-8")
        req = urllib.request.Request(
            self._base_url + path,
            data=data,
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=self._timeout) as resp:
                return Response(resp.status, resp.read().decode("utf-8"))
        except urllib.error.HTTPError as err:
            return Response(err.code, err.read().decode("utf-8"))

    def close(self):
        pass
