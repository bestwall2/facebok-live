
#!/usr/bin/env python3
"""
Resilient multi-streamer: one source per live video with automatic restart on errors.

This version replaces the earlier simple runner with a StreamWorker class that:
- Starts ffmpeg in its own process group.
- Reads ffmpeg stderr and treats error-like lines as signals to restart the process.
- Performs exponential backoff when restarting a failing ffmpeg instance.
- Uses more tolerant ffmpeg/input flags to handle HLS/network glitches:
    - '-fflags +genpts+igndts+nobuffer+discardcorrupt'
    - '-err_detect ignore_err'
    - '-rw_timeout' to limit blocking reads
    - reduced ffmpeg loglevel to 'error' so only serious messages appear
- Prints/logs only ffmpeg error lines (keeps stdout quieter).
- Gracefully terminates ffmpeg and all children on SIGINT/SIGTERM.

Usage:
- Set ACCESS_TOKEN in env.
- Provide SOURCES via env var (comma-separated). Each created stream key will be mapped to one source, cycling if needed.
- CREATE_COUNT controls how many unpublished live videos are created.
- Run: python3 stream.py
"""

from __future__ import annotations
import os
import sys
import time
import signal
import logging
import subprocess
import threading
from typing import List, Dict, Optional

try:
    import requests
except Exception:
    print("Missing dependency 'requests'. Install with: pip install requests")
    raise

# ========== CONFIG ==========
SOURCES_ENV = os.getenv(
    "SOURCES",
    "http://185.226.172.11:8080/mo3ad/mo3ad1.m3u8,http://185.226.172.11:8080/mo3ad/mo3ad2.m3u8,http://185.226.172.11:8080/mo3ad/mo3ad3.m3u8",
)
SOURCES = [s.strip() for s in SOURCES_ENV.split(",") if s.strip()]

ACCESS_TOKEN = os.getenv("ACCESS_TOKEN", "EAAKXMxkBFCIBQXuVhGhiDHmzP94DK2mp0BQQZC7Jel2ybOiDg99yKKTIFZCE8PmfmgaLIvBODGgISEqy8SZCMqjYKw7ZBb1oWZCtJj9t97jssSWBkAOp5xdYwVtzQ9skg1uKEEkxZCpWw3XWZCMhMqlpxZC5JxkemvLvBACFFwhbvRvh5mnOTRn52KkyFUcjy4GHnl9TwLqv0igqOUutjZBl1HuIZD")
FB_API_VERSION = os.getenv("FB_API_VERSION", "v24.0")
FB_GRAPH_BASE = f"https://graph.facebook.com/{FB_API_VERSION}"
CREATE_COUNT = int(os.getenv("CREATE_COUNT", "3"))
FFMPEG_PATH = os.getenv("FFMPEG_PATH", "/usr/bin/ffmpeg")

# Restart/backoff settings
RESTART_BASE_DELAY = 2
RESTART_MAX_DELAY = 60
MAX_RESTARTS = None  # None = unlimited

# Logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("streamer")

# ========== FFMPEG CMD ==========
def build_ffmpeg_cmd(source: str, rtmp_target: str) -> List[str]:
    # Using conservative/robust options for network/HLS inputs and tolerating corrupt frames.
    return [
        FFMPEG_PATH,
        "-loglevel", "error",  # emit only errors from ffmpeg itself
        "-re",
        # Input-related options to make HLS/HTTP more robust
        "-fflags", "+genpts+igndts+nobuffer+discardcorrupt",
        "-err_detect", "ignore_err",
        "-rw_timeout", "3000000",  # microseconds? ffmpeg expects microseconds
        "-reconnect", "1",
        "-reconnect_streamed", "1",
        "-reconnect_at_eof", "1",
        "-reconnect_delay_max", "5",
        "-thread_queue_size", "4096",
        "-user_agent", "Mozilla/5.0",
        "-i", source,
        # mappings
        "-map", "0:v:0",
        "-map", "0:a:0?",
        # video
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-profile:v", "high",
        "-level", "4.2",
        "-pix_fmt", "yuv420p",
        "-r", "30",
        "-g", "60",
        "-keyint_min", "60",
        "-sc_threshold", "0",
        "-b:v", "4500k",
        "-maxrate", "4500k",
        "-bufsize", "9000k",
        "-x264opts", "nal-hrd=cbr:force-cfr=1",
        # audio
        "-c:a", "aac",
        "-b:a", "128k",
        "-ac", "2",
        "-ar", "48000",
        # output
        "-f", "flv",
        "-rtmp_live", "live",
        "-flvflags", "no_duration_filesize",
        rtmp_target,
    ]

# ========== FACEBOOK GRAPH HELPERS ==========
def create_unpublished_live(access_token: str, title: str = "") -> Dict:
    url = f"{FB_GRAPH_BASE}/me/live_videos"
    params = {"access_token": access_token, "published": "false"}
    if title:
        params["title"] = title
    logger.info("Creating unpublished live video: %s", title or "(no title)")
    resp = requests.post(url, data=params, timeout=20)
    data = _resp_json_or_raise(resp, "create live video")
    logger.info("Created live video id=%s", data.get("id"))
    return data

def fetch_live_details(live_id: str, access_token: str) -> Dict:
    fields = "id,stream_url,secure_stream_url,stream_key,dash_preview_url"
    url = f"{FB_GRAPH_BASE}/{live_id}"
    params = {"access_token": access_token, "fields": fields}
    logger.info("Fetching details for live id=%s", live_id)
    resp = requests.get(url, params=params, timeout=20)
    data = _resp_json_or_raise(resp, f"fetch details for {live_id}")
    logger.info("Fetched details for id=%s: fields=%s", live_id, ", ".join(k for k in data.keys()))
    return data

def _resp_json_or_raise(resp: requests.Response, action: str) -> Dict:
    try:
        data = resp.json()
    except Exception:
        logger.error("Invalid JSON response while trying to %s. Status=%s, Text=%s", action, resp.status_code, resp.text)
        raise RuntimeError(f"Invalid JSON response during {action}")
    if resp.status_code >= 400 or "error" in data:
        logger.error("Graph API error while trying to %s: %s", action, data.get("error", data))
        raise RuntimeError(f"Graph API error during {action}: {data}")
    return data

def create_multiple_lives(count: int, access_token: str) -> List[Dict]:
    created = []
    for i in range(1, count + 1):
        title = f"AutoStream #{i} - created by script"
        try:
            created_resp = create_unpublished_live(access_token, title=title)
            live_id = created_resp.get("id")
            if not live_id:
                raise RuntimeError("Missing id in create response")
            details = fetch_live_details(live_id, access_token)
            entry = {
                "id": live_id,
                "stream_url": details.get("stream_url") or details.get("secure_stream_url"),
                "stream_key": details.get("stream_key"),
                "dash_preview_url": details.get("dash_preview_url"),
                "raw": details,
            }
            logger.info("Live #%s created: id=%s, stream_url=%s, stream_key=%s, dash_preview=%s",
                        i, entry["stream_url"], entry["id"], entry["stream_key"], entry["dash_preview_url"])
            created.append(entry)
        except Exception as exc:
            logger.exception("Failed to create/fetch live #%s: %s", i, exc)
    return created

# ========== STREAM WORKER ==========
class StreamWorker:
    def __init__(self, name: str, source: str, target: str):
        self.name = name
        self.source = source
        self.target = target
        self.process: Optional[subprocess.Popen] = None
        self._stop = threading.Event()
        self._stderr_error = threading.Event()
        self._restart_count = 0
        self._thread = threading.Thread(target=self._run_loop, daemon=True)

    def start(self):
        logger.info("%s: starting worker", self.name)
        self._thread.start()

    def stop(self):
        logger.info("%s: stop requested", self.name)
        self._stop.set()
        self._terminate_process()

    def _run_loop(self):
        delay = RESTART_BASE_DELAY
        while not self._stop.is_set():
            self._stderr_error.clear()
            logger.info("%s: launching ffmpeg (attempt #%d)", self.name, self._restart_count + 1)
            try:
                self._start_process()
                # Watch process: if it exits or stderr reported fatal error, handle restart
                while not self._stop.is_set():
                    if self.process is None:
                        break
                    ret = self.process.poll()
                    if ret is not None:
                        logger.warning("%s: ffmpeg exited with code %s", self.name, ret)
                        break
                    if self._stderr_error.is_set():
                        logger.warning("%s: fatal error reported on stderr, restarting ffmpeg", self.name)
                        # give ffmpeg a moment to flush/exit
                        time.sleep(0.5)
                        break
                    time.sleep(0.5)
            except Exception:
                logger.exception("%s: unexpected exception in worker loop", self.name)
            finally:
                self._terminate_process()

            if self._stop.is_set():
                break

            self._restart_count += 1
            if (MAX_RESTARTS is not None) and (self._restart_count > MAX_RESTARTS):
                logger.error("%s: reached max restart limit (%s). Not restarting.", self.name, MAX_RESTARTS)
                break

            logger.info("%s: restarting in %s seconds...", self.name, delay)
            time.sleep(delay)
            delay = min(delay * 2, RESTART_MAX_DELAY)

        logger.info("%s: worker exiting", self.name)

    def _start_process(self):
        cmd = build_ffmpeg_cmd(self.source, self.target)
        popen_kwargs = {
            "stdout": subprocess.DEVNULL,
            "stderr": subprocess.PIPE,
            "bufsize": 1,
            "universal_newlines": True,
        }
        if os.name == "nt":
            popen_kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
        else:
            popen_kwargs["preexec_fn"] = os.setsid

        self.process = subprocess.Popen(cmd, **popen_kwargs)
        logger.info("%s: ffmpeg started pid=%s", self.name, self.process.pid)
        # start stderr reader thread
        threading.Thread(target=self._stderr_reader, daemon=True).start()

    def _stderr_reader(self):
        if not self.process or not self.process.stderr:
            return
        try:
            for raw in self.process.stderr:
                line = raw.rstrip()
                if not line:
                    continue
                # Only consider serious lines: ffmpeg invoked with -loglevel error usually provides error lines.
                # Print to stdout for visibility + log as error.
                print(f"{self.name} | {line}")
                logger.error("%s: %s", self.name, line)

                # Decide whether to treat this as a fatal error that should trigger a restart.
                # Patterns that indicate input/network or demuxer failures are treated as fatal.
                lower = line.lower()
                if (
                    "error during demuxing" in lower
                    or "error retrieving a packet" in lower
                    or "connection timed out" in lower
                    or "input/output error" in lower
                    or "error while decoding" in lower
                    or "error writing trailer" in lower
                ):
                    # signal worker to restart ffmpeg
                    self._stderr_error.set()
        except Exception:
            # reader may fail if process closes; ignore
            pass

    def _terminate_process(self):
        if not self.process:
            return
        try:
            pid = self.process.pid
            logger.info("%s: terminating ffmpeg pid=%s", self.name, pid)
            if os.name == "nt":
                try:
                    self.process.send_signal(signal.CTRL_BREAK_EVENT)
                except Exception:
                    pass
                time.sleep(1)
                if self.process.poll() is None:
                    self.process.kill()
            else:
                try:
                    os.killpg(os.getpgid(pid), signal.SIGTERM)
                except Exception:
                    try:
                        self.process.terminate()
                    except Exception:
                        pass
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                logger.warning("%s: ffmpeg did not exit, force killing pid=%s", self.name, pid)
                if os.name == "nt":
                    self.process.kill()
                else:
                    try:
                        os.killpg(os.getpgid(pid), signal.SIGKILL)
                    except Exception:
                        self.process.kill()
        except Exception:
            logger.exception("%s: error while terminating process", self.name)
        finally:
            # close stderr to release reader loop
            try:
                if self.process and self.process.stderr:
                    self.process.stderr.close()
            except Exception:
                pass
            self.process = None

# ========== MANAGER & SIGNALS ==========
workers: List[StreamWorker] = []

def shutdown(signum=None, frame=None):
    logger.info("Shutdown requested (signal=%s). Stopping workers...", signum)
    for w in workers:
        w.stop()

signal.signal(signal.SIGINT, shutdown)
signal.signal(signal.SIGTERM, shutdown)

# ========== MAIN ==========
def main():
    if not ACCESS_TOKEN:
        logger.error("ACCESS_TOKEN is required. Set environment variable ACCESS_TOKEN.")
        sys.exit(1)
    if not SOURCES:
        logger.error("No sources provided. Set env var SOURCES.")
        sys.exit(1)

    logger.info("Creating %d unpublished live videos...", CREATE_COUNT)
    created = create_multiple_lives(CREATE_COUNT, ACCESS_TOKEN)
    if not created:
        logger.error("No live videos were created. Exiting.")
        sys.exit(1)

    pairs = []
    for i, entry in enumerate(created):
        live_id = entry.get("id")
        stream_url = entry.get("stream_url")
        stream_key = entry.get("stream_key")
        dash = entry.get("dash_preview_url")

        if stream_url:
            target = stream_url
        elif stream_key:
            target = f"rtmps://live-api-s.facebook.com:443/rtmp/{stream_key}"
        else:
            logger.error("No stream_url or stream_key for id=%s. Skipping.", live_id)
            continue

        source = SOURCES[i % len(SOURCES)]
        logger.info("Mapping #%d: id=%s -> source=%s -> target=%s (dash=%s)", i + 1, live_id, source, target, dash)
        pairs.append({"id": live_id, "source": source, "target": target, "stream_key": stream_key, "dash": dash})

    if not pairs:
        logger.error("No valid pairs to stream. Exiting.")
        sys.exit(1)

    # Create and start one worker per pair
    for idx, p in enumerate(pairs, start=1):
        name = f"ffmpeg#{idx}"
        w = StreamWorker(name, p["source"], p["target"])
        workers.append(w)
        w.start()

    logger.info("Workers started. Summary:")
    for idx, p in enumerate(pairs, start=1):
        logger.info("Stream #%d: id=%s, source=%s, target=%s, dash=%s", idx, p["id"], p["source"], p["target"], p["dash"])

    # Wait until all workers exit (they only exit on stop request or if restart limit reached)
    try:
        while True:
            alive = any(t._thread.is_alive() for t in workers)
            if not alive:
                logger.info("All workers finished.")
                break
            time.sleep(1)
    except KeyboardInterrupt:
        logger.info("KeyboardInterrupt received, shutting down.")
        shutdown()

    # Final cleanup
    for w in workers:
        w.stop()
    logger.info("Exited.")

if __name__ == "__main__":
    main()
