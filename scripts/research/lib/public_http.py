"""Bounded, credential-free downloads of untrusted public podcast resources.

Resolve and validate every redirect, then connect to that exact IP rather than
resolving the hostname a second time (DNS rebinding). HTTPS still verifies the
original hostname and sends it as SNI. No environment proxies, netrc credentials,
cookies, or API keys are inherited by these public-resource requests.
"""

from __future__ import annotations

import ipaddress
import socket
import time
from io import BytesIO
from typing import BinaryIO
from urllib.parse import ParseResult, quote, urljoin, urlparse

import urllib3
from requests.certs import where as ca_bundle

MAX_REDIRECTS = 5
# Best-effort deadline between DNS/network reads; individual socket operations
# use bounded timeouts, but OS DNS and a pending read can outlast this budget.
MAX_DOWNLOAD_SECONDS = 600
_REDIRECTS = {301, 302, 303, 307, 308}


def _public_target(url: str) -> tuple[ParseResult, str]:
    if not isinstance(url, str) or any(ord(c) < 33 or ord(c) == 127 for c in url):
        raise ValueError("invalid public URL")
    try:
        parsed = urlparse(url)
        port = parsed.port
        host = parsed.hostname
    except ValueError:
        raise ValueError("invalid public URL") from None
    if parsed.scheme not in {"http", "https"} or not host:
        raise ValueError("public resource must use HTTP or HTTPS")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("public resource URL must not contain credentials")
    if port is not None and not 1 <= port <= 65535:
        raise ValueError("invalid public URL port")
    try:
        # Use the same canonical spelling for DNS, SNI, and the Host header.
        host = host.encode("idna").decode("ascii")
        infos = socket.getaddrinfo(host, port or (443 if parsed.scheme == "https" else 80),
                                   type=socket.SOCK_STREAM)
    except (OSError, UnicodeError):
        raise ValueError("cannot resolve public resource host") from None
    addresses = []
    for info in infos:
        try:
            address = ipaddress.ip_address(info[4][0])
        except ValueError:
            raise ValueError("invalid resolved address") from None
        if not address.is_global or address.is_multicast or address.is_reserved:
            raise ValueError("public resource resolves to a non-public address")
        if address.version == 6 and (address.ipv4_mapped or address.sixtofour or address.teredo):
            # Conservatively reject IPv4-embedding transition addresses across
            # supported Python versions whose is_global classifications differ.
            raise ValueError("public resource uses an unsupported transition address")
        addresses.append(address)
    if not addresses:
        raise ValueError("public resource host has no addresses")
    # Prefer IPv4 where both families exist; every returned address was checked.
    address = min(addresses, key=lambda candidate: candidate.version)
    return parsed, str(address)


def safe_fetch_url(url: str) -> str | None:
    """Compatibility validator; downloads also validate AND pin the connection."""
    try:
        _public_target(url)
    except ValueError as exc:
        return str(exc)
    return None


def download_public(url: str, sink: BinaryIO, *, max_bytes: int) -> tuple[dict[str, str], str]:
    """Write at most max_bytes; return final headers and URL. Caller owns sink.

    The byte budget applies to the actual stream, not just Content-Length.
    Compressed HTTP bodies are refused (even if the server ignores our identity
    request), avoiding decompression bombs before a byte counter can intervene.
    Redirect bodies are never read. Caller owns partial temporary files.
    """
    if max_bytes <= 0:
        raise ValueError("download byte limit must be positive")
    deadline = time.monotonic() + MAX_DOWNLOAD_SECONDS
    for hop in range(MAX_REDIRECTS + 1):
        if time.monotonic() >= deadline:
            raise ValueError("public resource download exceeded time limit")
        parsed, address = _public_target(url)
        host = parsed.hostname.encode("idna").decode("ascii")
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        host_header = f"[{host}]" if ":" in host else host
        if port != (443 if parsed.scheme == "https" else 80):
            host_header += f":{port}"
        remaining = max(0.001, deadline - time.monotonic())
        kwargs = {"port": port, "timeout": urllib3.Timeout(connect=min(15, remaining),
                                                          read=min(60, remaining))}
        if parsed.scheme == "https":
            pool = urllib3.HTTPSConnectionPool(
                address, server_hostname=host, assert_hostname=host,
                cert_reqs="CERT_REQUIRED", ca_certs=ca_bundle(), **kwargs,
            )
        else:
            pool = urllib3.HTTPConnectionPool(address, **kwargs)
        target = parsed.path or "/"
        if parsed.params:
            target += ";" + parsed.params
        if parsed.query:
            target += "?" + parsed.query
        target = quote(target, safe="/%?=&;:+,@!$'()*[]~")
        response = None
        try:
            response = pool.request(
                "GET", target, headers={"Host": host_header,
                                        "User-Agent": "Obsidian-Second-Brain/1.0",
                                        "Accept-Encoding": "identity"},
                assert_same_host=False, redirect=False, retries=False,
                preload_content=False,
            )
            if response.status in _REDIRECTS:
                location = response.headers.get("Location", "")
                if not location or hop == MAX_REDIRECTS:
                    raise ValueError("invalid or excessive public resource redirects")
                url = urljoin(url, location)
                continue
            if not 200 <= response.status < 300:
                raise ValueError(f"public resource returned HTTP {response.status}")
            if response.headers.get("Content-Encoding", "").strip().lower() not in {"", "identity"}:
                raise ValueError("compressed public resources are not supported")
            length = response.headers.get("Content-Length")
            if length is not None and (not length.isascii() or not length.isdecimal()
                                       or int(length) > max_bytes):
                raise ValueError("public resource exceeds byte limit or has invalid length")
            total = 0
            for chunk in response.stream(amt=min(64 * 1024, max_bytes + 1), decode_content=False):
                total += len(chunk)
                if total > max_bytes:
                    raise ValueError("public resource exceeds byte limit")
                if time.monotonic() >= deadline:
                    raise ValueError("public resource download exceeded time limit")
                sink.write(chunk)
            return {key.lower(): value for key, value in response.headers.items()}, url
        finally:
            if response is not None:
                response.close()
            pool.close()
    raise ValueError("excessive public resource redirects")


def fetch_public_bytes(url: str, *, max_bytes: int) -> tuple[bytes, dict[str, str], str]:
    """Fetch a small bounded feed/transcript without exposing a URL to its parser."""
    with BytesIO() as sink:
        headers, final_url = download_public(url, sink, max_bytes=max_bytes)
        return sink.getvalue(), headers, final_url
