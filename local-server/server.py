"""Local AI subtitle service for Read Frog.

Mirrors the hosted video-transcript flow (create job -> poll -> fetch subtitles)
so the extension can transcribe YouTube videos on this Mac with MLX Whisper.

    POST /v1/transcripts                 {"url": "...", "durationSec": 123}
    GET  /v1/transcripts/<id>            job status
    GET  /v1/transcripts/<id>/subtitles  {"segments": [...], "detectedLanguage": "en"}
    GET  /health

Binds to 127.0.0.1 only. Requests must be JSON, which browsers cannot send
cross-origin without a CORS preflight this server never approves, so web pages
cannot drive it; the extension reaches it through its background page.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import queue
import re
import shutil
import tempfile
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

DEFAULT_MODEL = "mlx-community/whisper-large-v3-turbo"
DATA_DIR = Path.home() / "Library/Application Support/ReadFrogLocal"
TRANSCRIPTS_DIR = DATA_DIR / "transcripts"
MAX_DURATION_SEC = 4 * 60 * 60
YOUTUBE_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")

log = logging.getLogger("read-frog-local")


def youtube_video_id(url: str) -> str | None:
    """Accept only YouTube watch/shorts/embed/youtu.be links; return the video id."""
    try:
        parsed = urlparse(url)
    except ValueError:
        return None
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return None
    host = parsed.hostname.lower()
    candidate = None
    if host == "youtu.be":
        candidate = parsed.path.lstrip("/").split("/")[0]
    elif host == "youtube.com" or host.endswith(".youtube.com") or host.endswith(
        "youtube-nocookie.com"
    ):
        if parsed.path == "/watch":
            candidate = parse_qs(parsed.query).get("v", [None])[0]
        else:
            parts = parsed.path.strip("/").split("/")
            if len(parts) >= 2 and parts[0] in ("shorts", "embed", "live"):
                candidate = parts[1]
    return candidate if candidate and YOUTUBE_ID.match(candidate) else None


def ensure_ffmpeg_on_path() -> None:
    """mlx-whisper shells out to `ffmpeg`; expose the bundled binary under that name."""
    if shutil.which("ffmpeg"):
        return
    import imageio_ffmpeg

    bin_dir = DATA_DIR / "bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    link = bin_dir / "ffmpeg"
    target = imageio_ffmpeg.get_ffmpeg_exe()
    if not link.exists() or os.path.realpath(link) != os.path.realpath(target):
        link.unlink(missing_ok=True)
        link.symlink_to(target)
    os.environ["PATH"] = f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}"


class Jobs:
    """In-memory job table backed by an on-disk transcript cache, one worker."""

    def __init__(self, model: str) -> None:
        self.model = model
        self.lock = threading.Lock()
        self.jobs: dict[str, dict] = {}
        self.pending: queue.Queue[str] = queue.Queue()
        TRANSCRIPTS_DIR.mkdir(parents=True, exist_ok=True)
        threading.Thread(target=self._worker, daemon=True).start()

    def _cache_path(self, job_id: str) -> Path:
        return TRANSCRIPTS_DIR / f"{job_id}.json"

    def _public(self, job: dict) -> dict:
        return {k: job[k] for k in ("id", "status", "detectedLanguage", "error")}

    def create(self, video_id: str) -> dict:
        job_id = hashlib.sha256(f"{video_id}|{self.model}".encode()).hexdigest()[:24]
        with self.lock:
            job = self.jobs.get(job_id)
            if job and job["status"] != "failed":
                return self._public(job)
            cached = self._cache_path(job_id)
            if cached.exists():
                data = json.loads(cached.read_text())
                job = {
                    "id": job_id,
                    "videoId": video_id,
                    "status": "completed",
                    "detectedLanguage": data.get("detectedLanguage"),
                    "error": None,
                }
            else:
                job = {
                    "id": job_id,
                    "videoId": video_id,
                    "status": "pending",
                    "detectedLanguage": None,
                    "error": None,
                }
                self.pending.put(job_id)
            self.jobs[job_id] = job
            return self._public(job)

    def get(self, job_id: str) -> dict | None:
        with self.lock:
            job = self.jobs.get(job_id)
            if job:
                return self._public(job)
        if self._cache_path(job_id).exists():
            data = json.loads(self._cache_path(job_id).read_text())
            return {
                "id": job_id,
                "status": "completed",
                "detectedLanguage": data.get("detectedLanguage"),
                "error": None,
            }
        return None

    def subtitles(self, job_id: str) -> dict | None:
        path = self._cache_path(job_id)
        return json.loads(path.read_text()) if path.exists() else None

    def _set(self, job_id: str, **fields) -> None:
        with self.lock:
            self.jobs[job_id].update(fields)

    def _worker(self) -> None:
        while True:
            job_id = self.pending.get()
            with self.lock:
                video_id = self.jobs[job_id]["videoId"]
            self._set(job_id, status="processing")
            started = time.monotonic()
            try:
                result = transcribe(video_id, self.model)
                self._cache_path(job_id).write_text(json.dumps(result, ensure_ascii=False))
                self._set(job_id, status="completed", detectedLanguage=result["detectedLanguage"])
                log.info(
                    "transcribed %s (%s, %d segments) in %.1fs",
                    video_id,
                    result["detectedLanguage"],
                    len(result["segments"]),
                    time.monotonic() - started,
                )
            except Exception as exc:  # report any failure to the extension, keep serving
                log.exception("transcription failed for %s", video_id)
                self._set(job_id, status="failed", error=str(exc)[:500])


def transcribe(video_id: str, model: str) -> dict:
    import mlx_whisper
    import yt_dlp

    with tempfile.TemporaryDirectory(prefix="read-frog-") as tmp:
        options = {
            "format": "bestaudio/best",
            "outtmpl": str(Path(tmp) / "audio.%(ext)s"),
            "quiet": True,
            "no_warnings": True,
            "noplaylist": True,
            "match_filter": yt_dlp.utils.match_filter_func(f"duration <= {MAX_DURATION_SEC}"),
        }
        with yt_dlp.YoutubeDL(options) as ydl:
            ydl.download([f"https://www.youtube.com/watch?v={video_id}"])
        audio = next(Path(tmp).glob("audio.*"), None)
        if audio is None:
            raise RuntimeError("audio download produced no file (video too long or unavailable)")

        output = mlx_whisper.transcribe(
            str(audio), path_or_hf_repo=model, condition_on_previous_text=False
        )

    segments = [
        {"start": round(s["start"], 3), "end": round(s["end"], 3), "text": s["text"].strip()}
        for s in output.get("segments", [])
        if s["text"].strip()
    ]
    return {"segments": segments, "detectedLanguage": output.get("language") or ""}


def make_handler(jobs: Jobs):
    class Handler(BaseHTTPRequestHandler):
        server_version = "ReadFrogLocal/0.1"

        def log_message(self, fmt: str, *args) -> None:
            log.debug("%s - %s", self.address_string(), fmt % args)

        def _send(self, status: HTTPStatus, payload: dict) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:
            parts = urlparse(self.path).path.strip("/").split("/")
            if parts == ["health"]:
                return self._send(HTTPStatus.OK, {"ok": True, "model": jobs.model})
            if len(parts) == 3 and parts[:2] == ["v1", "transcripts"]:
                job = jobs.get(parts[2])
                if job:
                    return self._send(HTTPStatus.OK, job)
            if len(parts) == 4 and parts[:2] == ["v1", "transcripts"] and parts[3] == "subtitles":
                data = jobs.subtitles(parts[2])
                if data:
                    return self._send(HTTPStatus.OK, data)
            self._send(HTTPStatus.NOT_FOUND, {"error": "not_found"})

        def do_POST(self) -> None:
            if urlparse(self.path).path.rstrip("/") != "/v1/transcripts":
                return self._send(HTTPStatus.NOT_FOUND, {"error": "not_found"})
            if not self.headers.get("Content-Type", "").startswith("application/json"):
                return self._send(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, {"error": "json_required"})
            try:
                length = min(int(self.headers.get("Content-Length", 0)), 64 * 1024)
                payload = json.loads(self.rfile.read(length) or b"{}")
            except (ValueError, json.JSONDecodeError):
                return self._send(HTTPStatus.BAD_REQUEST, {"error": "invalid_json"})
            video_id = youtube_video_id(str(payload.get("url", "")))
            if not video_id:
                return self._send(HTTPStatus.BAD_REQUEST, {"error": "unsupported_url"})
            duration = payload.get("durationSec")
            if isinstance(duration, (int, float)) and duration > MAX_DURATION_SEC:
                return self._send(HTTPStatus.BAD_REQUEST, {"error": "video_too_long"})
            self._send(HTTPStatus.OK, jobs.create(video_id))

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, default=int(os.environ.get("READ_FROG_LOCAL_PORT", 8765)))
    parser.add_argument("--model", default=os.environ.get("READ_FROG_WHISPER_MODEL", DEFAULT_MODEL))
    parser.add_argument("--warmup", action="store_true", help="download/load the model, then exit")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    ensure_ffmpeg_on_path()

    if args.warmup:
        from huggingface_hub import snapshot_download

        log.info("downloading %s ...", args.model)
        snapshot_download(args.model)
        log.info("model ready")
        return

    jobs = Jobs(args.model)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(jobs))
    log.info("Read Frog local server on http://127.0.0.1:%d (model %s)", args.port, args.model)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
