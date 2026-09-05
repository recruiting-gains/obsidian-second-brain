"""Offline SSRF/resource-boundary regressions; no provider, DNS, or real sockets."""

from __future__ import annotations

import gzip
import socket
import sys
from io import BytesIO
from types import SimpleNamespace

import pytest
from urllib3.response import HTTPResponse

from scripts.research.lib import podcast, public_http

PUBLIC = "https://media.example/episode"


@pytest.fixture
def network(monkeypatch):
    calls = []
    replies = []
    lookups = []

    def resolve(host, port, **kwargs):
        lookups.append(host)
        address = {
            "media.example": "93.184.216.34", "cdn.example": "1.1.1.1",
            "localhost": "127.0.0.1", "private.example": "10.0.0.1",
        }.get(host, host)
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, port))]

    class Pool:
        def __init__(self, address, **kwargs):
            self.record = {"address": address, "options": kwargs, "closed": False}
            calls.append(self.record)

        def request(self, method, target, **kwargs):
            self.record.update(method=method, target=target, request=kwargs)
            assert replies, "unexpected download; no real network is ever allowed"
            return replies.pop(0)

        def close(self):
            self.record["closed"] = True

    def reply(body=b"ok", status=200, **headers):
        result = HTTPResponse(body=BytesIO(body), status=status, headers=headers,
                              preload_content=False)
        replies.append(result)
        return result

    monkeypatch.setattr(socket, "getaddrinfo", resolve)
    monkeypatch.setattr(public_http.urllib3, "HTTPConnectionPool", Pool)
    monkeypatch.setattr(public_http.urllib3, "HTTPSConnectionPool", Pool)
    return SimpleNamespace(calls=calls, reply=reply, lookups=lookups)


@pytest.mark.parametrize("url", [
    "http://localhost/", "http://127.0.0.1/", "http://169.254.169.254/",
    "http://10.0.0.1/", "http://100.64.0.1/", "http://[::1]/",
    "http://[::ffff:127.0.0.1]/", "http://[fc00::1]/", "http://[fe80::1]/",
    "http://[2002:0a00:0001::]/", "http://[64:ff9b::7f00:1]/",
    "http://224.0.0.1/", "file:///test-fixture", "https://user:password@media.example/",
    "https://media.example:0/", "https://media.example:99999/", "https://media.example/\npath",
])
def test_non_public_initial_urls_never_open_a_connection(network, url):
    with pytest.raises(ValueError):
        public_http.fetch_public_bytes(url, max_bytes=100)
    assert network.calls == []


def test_empty_or_mixed_dns_answers_fail_closed(network, monkeypatch):
    for answers in ([], [(2, 1, 6, "", ("93.184.216.34", 443)),
                         (2, 1, 6, "", ("127.0.0.1", 443))]):
        monkeypatch.setattr(socket, "getaddrinfo", lambda *a, **kw: answers)
        with pytest.raises(ValueError):
            public_http.fetch_public_bytes(PUBLIC, max_bytes=100)
    assert network.calls == []


def test_https_connection_is_pinned_but_keeps_strict_tls_and_original_host(network, monkeypatch):
    monkeypatch.setenv("HTTPS_PROXY", "http://proxy.invalid:1234")
    network.reply(b"content")
    body, _, _ = public_http.fetch_public_bytes(PUBLIC, max_bytes=100)
    assert body == b"content"
    assert network.lookups == ["media.example"]
    call = network.calls[0]
    assert call["address"] == "93.184.216.34", "connect to checked IP, never re-resolve host"
    assert call["options"]["server_hostname"] == "media.example"
    assert call["options"]["assert_hostname"] == "media.example"
    assert call["options"]["cert_reqs"] == "CERT_REQUIRED"
    assert call["options"]["ca_certs"]
    assert call["request"]["redirect"] is False
    assert call["request"]["retries"] is False
    assert call["request"]["preload_content"] is False
    assert call["request"]["headers"] == {
        "Host": "media.example", "User-Agent": "Obsidian-Second-Brain/1.0",
        "Accept-Encoding": "identity",
    }
    assert call["closed"]


@pytest.mark.parametrize("location", ["http://localhost/admin", "http://private.example/",
                                       "//169.254.169.254/metadata", "file:///fixture"])
def test_redirects_into_private_network_are_refused_before_connection(network, location):
    response = network.reply(status=302, Location=location)
    with pytest.raises(ValueError):
        public_http.fetch_public_bytes(PUBLIC, max_bytes=100)
    assert len(network.calls) == 1
    assert network.calls[0]["closed"] and response.closed


def test_public_and_relative_redirects_still_work(network):
    network.reply(status=301, Location="/new-path")
    network.reply(status=307, Location="https://cdn.example/final")
    network.reply(b"hello", **{"Content-Type": "text/plain"})
    body, headers, final_url = public_http.fetch_public_bytes(PUBLIC, max_bytes=100)
    assert body == b"hello" and headers["content-type"] == "text/plain"
    assert final_url == "https://cdn.example/final"
    assert network.calls[1]["target"] == "/new-path"
    assert network.calls[2]["address"] == "1.1.1.1"
    assert all(call["closed"] for call in network.calls)


def test_redirect_loop_is_bounded(network):
    for _ in range(public_http.MAX_REDIRECTS + 1):
        network.reply(status=302, Location="/again")
    with pytest.raises(ValueError, match="redirect"):
        public_http.fetch_public_bytes(PUBLIC, max_bytes=100)
    assert len(network.calls) == public_http.MAX_REDIRECTS + 1
    assert all(call["closed"] for call in network.calls)


@pytest.mark.parametrize("length", [None, "1", "20", "invalid", "-1"])
def test_advertised_and_actual_bytes_are_bounded(network, length):
    headers = {} if length is None else {"Content-Length": length}
    network.reply(b"A" * 20, **headers)
    sink = BytesIO()
    with pytest.raises(ValueError, match="limit|length"):
        public_http.download_public(PUBLIC, sink, max_bytes=10)
    assert len(sink.getvalue()) <= 10
    assert network.calls[0]["closed"]


def test_compression_bomb_is_refused_without_reading_it(network):
    response = network.reply(gzip.compress(b"A" * 100_000), **{"Content-Encoding": "gzip"})
    response.stream = lambda **kwargs: pytest.fail("compressed response must not be read or decoded")
    with pytest.raises(ValueError, match="compressed"):
        public_http.fetch_public_bytes(PUBLIC, max_bytes=100)
    assert response.closed


def test_time_budget_checks_between_reads(network, monkeypatch):
    network.reply(b"data")
    now = iter([0, 0, 0, public_http.MAX_DOWNLOAD_SECONDS + 1])
    monkeypatch.setattr(public_http.time, "monotonic", lambda: next(now))
    with pytest.raises(ValueError, match="time limit"):
        public_http.fetch_public_bytes(PUBLIC, max_bytes=100)
    assert network.calls[0]["closed"]


def test_feed_parser_receives_only_bounded_bytes(network, monkeypatch):
    import feedparser

    actual_parser = feedparser.parse
    calls = []

    def parser(data, **kwargs):
        assert isinstance(data, bytes), "feedparser must not initiate its own network request"
        calls.append(data)
        return actual_parser(data, **kwargs)

    monkeypatch.setattr(feedparser, "parse", parser)
    network.reply(b'<rss version="2.0"><channel><title>Offline test</title><item>'
                  b'<title>Episode</title><enclosure url="https://cdn.example/audio.mp3" '
                  b'type="audio/mpeg"/></item></channel></rss>')
    result = podcast.parse_feed(PUBLIC)
    assert result["show_title"] == "Offline test" and len(calls) == 1
    monkeypatch.setattr(podcast, "MAX_FEED_BYTES", 10)
    network.reply(b"X" * 11)
    with pytest.raises(ValueError, match="limit"):
        podcast.parse_feed(PUBLIC)
    assert len(calls) == 1


def test_transcript_rejects_redirects_and_size_without_provider_calls(network, monkeypatch):
    network.reply(status=302, Location="http://private.example/")
    assert podcast.fetch_transcript_tag(PUBLIC) is None
    monkeypatch.setattr(podcast, "MAX_TRANSCRIPT_BYTES", 10)
    network.reply(b"X" * 11)
    assert podcast.fetch_transcript_tag(PUBLIC) is None
    network.reply(b"hello", **{"Content-Type": "text/plain"})
    assert podcast.fetch_transcript_tag(PUBLIC) == "hello"


def test_whisper_refuses_redirect_and_cleans_partial_download(network, monkeypatch, tmp_path):
    monkeypatch.setenv("OPENAI_API_KEY", "offline-test-only")
    monkeypatch.setitem(sys.modules, "openai", SimpleNamespace(
        OpenAI=lambda **kwargs: pytest.fail("must not call a provider after refused download")))
    monkeypatch.setattr(podcast.tempfile, "tempdir", str(tmp_path))
    network.reply(status=302, Location="http://private.example/")
    assert podcast.transcribe_via_whisper(PUBLIC) is None
    network.reply(b"X" * 11)
    assert podcast.transcribe_via_whisper(PUBLIC, max_bytes=10) is None
    assert list(tmp_path.iterdir()) == []


def test_groq_source_download_has_independent_limits_and_redirect_guard(network, monkeypatch, tmp_path):
    monkeypatch.setenv("OBSIDIAN_ENV_FILE", str(tmp_path / "no-config"))
    monkeypatch.setenv("OBSIDIAN_VAULT_PATH", str(tmp_path / "no-vault"))
    from scripts.research.lib import groq

    monkeypatch.setattr(groq, "GROQ_MAX_DOWNLOAD_BYTES", 10)
    target = tmp_path / "audio"
    network.reply(b"X" * 11)
    with pytest.raises(ValueError, match="limit"):
        groq._download_audio(PUBLIC, target, lambda url: None)
    assert target.stat().st_size <= 10
    network.reply(status=302, Location="http://private.example/")
    with pytest.raises(ValueError, match="non-public"):
        groq._download_audio(PUBLIC, target, lambda url: None)


def test_native_audio_tools_cannot_select_network_protocols_or_playlist_formats(monkeypatch, tmp_path):
    monkeypatch.setenv("OBSIDIAN_ENV_FILE", str(tmp_path / "no-config"))
    monkeypatch.setenv("OBSIDIAN_VAULT_PATH", str(tmp_path / "no-vault"))
    from scripts.research.lib import groq

    commands = []

    def run(argv, **kwargs):
        commands.append(argv)
        return SimpleNamespace(stdout=b"30\n")

    monkeypatch.setattr(groq, "_run", run)
    source, output = tmp_path / "download", tmp_path / "encoded.mp3"
    groq._ffprobe_duration_seconds(source)
    groq._downsample_to_mono_mp3(source, output)
    groq._split_reencoded_chunks(output, 20, tmp_path)
    assert {cmd[0] for cmd in commands} == {"ffprobe", "ffmpeg"}
    for cmd in commands:
        assert cmd[cmd.index("-protocol_whitelist") + 1] == "file"
        formats = set(cmd[cmd.index("-format_whitelist") + 1].split(","))
        assert formats == {"mp3", "mov", "ogg", "wav", "flac", "aac"}
        assert not formats & {"hls", "dash", "concat"}
        assert "-enable_drefs" not in cmd and "-use_absolute_path" not in cmd
        if "-i" in cmd:
            assert cmd.index("-protocol_whitelist") < cmd.index("-i")
