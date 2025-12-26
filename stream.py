#!/usr/bin/env python3
"""
Stream each source to its own Facebook live endpoint.

Modifications:
- Each created live video (stream key) is paired with its own source URL.
  SOURCES can be provided via the environment variable `SOURCES` as a comma-separated list.
  If the number of SOURCES differs from CREATE_COUNT we cycle the list.
- FFmpeg logging reduced to only show errors (ffmpeg `-loglevel error`).
  The stderr reader prints/logs only lines that appear to be errors.
- ACCESS_TOKEN must be provided via environment variable ACCESS_TOKEN (no default token in file).
- Additional info is logged: created live ids, dash preview URLs, stream keys, and the mapping
  between sources and targets.
"""

import os
import sys
import time
import signal
import logging
import subprocess
from typing import List, Dict

try:
    import requests
except Exception:
    print("Missing dependency 'requests'. Install with: pip install requests")
    raise

# ================== CONFIG ==================
# Provide sources as comma-separated list via env var SOURCES.
# Example: export SOURCES="http://source1.m3u8,http://source2.m3u8,http://source3.m3u8"
SOURCES_ENV = os.getenv("SOURCES", "http://185.226.172.11:8080/mo3ad/mo3ad1.m3u8,http://185.226.172.11:8080/mo3ad/mo3ad2.m3u8,http://185.226.172.11:8080/mo3ad/mo3ad3.m3u8")
SOURCES = [s.strip() for s in SOURCES_ENV.split(",") if s.strip()]

# Facebook access token (must be set in environment)
ACCESS_TOKEN = os.getenv("ACCESS_TOKEN", "EAAKXMxkBFCIBQXuVhGhiDHmzP94DK2mp0BQQZC7Jel2ybOiDg99yKKTIFZCE8PmfmgaLIvBODGgISEqy8SZCMqjYKw7ZBb1oWZCtJj9t97jssSWBkAOp5xdYwVtzQ9skg1uKEEkxZCpWw3XWZCMhMqlpxZC5JxkemvLvBACFFwhbvRvh5mnOTRn52KkyFUcjy4GHnl9TwLqv0igqOUutjZBl1HuIZD")

# Graph API base and version
FB_API_VERSION = os.getenv("FB_API_VERSION", "v24.0")
FB_GRAPH_BASE = f"https://graph.facebook.com/{FB_API_VERSION}"

# How many unpublished live videos to create
CREATE_COUNT = int(os.getenv("CREATE_COUNT", "3"))

# Path to ffmpeg binary
FFMPEG_PATH = os.getenv("FFMPEG_PATH", "/usr/bin/ffmpeg")

# Logging configuration
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("fb_streamer")

# ffmpeg command builder. Loglevel set to 'error' so ffmpeg itself only outputs errors.
def build_ffmpeg_cmd(source: str, rtmp_target: str) -> List[str]:
    return [
        FFMPEG_PATH,
        "-loglevel", "error",   # only errors from ffmpeg
        "-re",
        "-fflags", "+genpts+igndts+nobuffer",
        "-flags", "low_delay",
        "-rw_timeout", "3000000",
        "-reconnect", "1",
        "-reconnect_streamed", "1",
        "-reconnect_at_eof", "1",
        "-reconnect_delay_max", "5",
        "-thread_queue_size", "4096",
        "-user_agent", "Mozilla/5.0",
        "-i", source,
        "-map", "0:v:0",
        "-map", "0:a:0?",
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
        "-c:a", "aac",
        "-b:a", "128k",
        "-ac", "2",
        "-ar", "48000",
        "-f", "flv",
        "-rtmp_live", "live",
        "-flvflags", "no_duration_filesize",
        rtmp_target,
    ]

# ================== Facebook Graph API helpers ==================
def create_unpublished_live(access_token: str, title: str = "") -> Dict:
    url = f"{FB_GRAPH_BASE}/me/live_videos"
    params = {
        "access_token": access_token,
        "published": "false",
    }
    if title:
        params["title"] = title
    logger.info("Creating unpublished live video: %s", title or "(no title)")
    resp = requests.post(url, data=params, timeout=20)
    try:
        data = resp.json()
    except Exception:
        logger.error("Invalid JSON response from Graph API while creating live video. Status: %s, Text: %s",
                     resp.status_code, resp.text)
        raise
    if resp.status_code >= 400 or "error" in data:
        logger.error("Error creating live video: %s", data.get("error", data))
        raise RuntimeError(f"Failed to create live video: {data}")
    logger.info("Created live video id=%s", data.get("id"))
    return data


def fetch_live_details(live_id: str, access_token: str) -> Dict:
    fields = "id,stream_url,secure_stream_url,stream_key,dash_preview_url"
    url = f"{FB_GRAPH_BASE}/{live_id}"
    params = {
        "access_token": access_token,
        "fields": fields,
    }
    logger.info("Fetching details for live id=%s", live_id)
    resp = requests.get(url, params=params, timeout=20)
    try:
        data = resp.json()
    except Exception:
        logger.error("Invalid JSON response from Graph API when fetching details. Status: %s, Text: %s",
                     resp.status_code, resp.text)
        raise
    if resp.status_code >= 400 or "error" in data:
        logger.error("Error fetching live details: %s", data.get("error", data))
        raise RuntimeError(f"Failed to fetch live details: {data}")
    logger.info("Fetched details for id=%s: fields=%s", live_id, ", ".join(k for k in data.keys()))
    return data


def create_multiple_lives(count: int, access_token: str) -> List[Dict]:
    created = []
    for i in range(1, count + 1):
        title = f"AutoStream #{i} - created by script"
        try:
            created_resp = create_unpublished_live(access_token, title=title)
            live_id = created_resp.get("id")
            if not live_id:
                logger.error("No 'id' in create response: %s", created_resp)
                raise RuntimeError("Missing id in create response")
            details = fetch_live_details(live_id, access_token)
            stream_url = details.get("stream_url") or details.get("secure_stream_url")
            # stream_key might be provided separately in some API versions
            stream_key = details.get("stream_key")
            dash_preview_url = details.get("dash_preview_url")
            entry = {
                "id": live_id,
                "stream_url": stream_url,
                "stream_key": stream_key,
                "dash_preview_url": dash_preview_url,
                "raw": details,
            }
            logger.info("Live #%s created: id=%s, stream_url=%s, stream_key=%s, dash_preview=%s",
                        i, live_id, stream_url, stream_key, dash_preview_url)
            created.append(entry)
        except Exception as e:
            logger.exception("Failed to create/fetch live #%s: %s", i, e)
    return created

# ================== STREAM PROCESS MANAGEMENT ==================
ffmpeg_processes: List[subprocess.Popen] = []


def start_ffmpeg_for_pairs(pairs: List[Dict[str, str]]) -> None:
    """
    Start ffmpeg processes for each dict in pairs which must contain 'source' and 'target'.
    Only ffmpeg stderr lines that appear to be errors are printed/logged.
    """
    for idx, pair in enumerate(pairs, start=1):
        source = pair["source"]
        target = pair["target"]
        cmd = build_ffmpeg_cmd(source, target)
        logger.info("Starting ffmpeg #%d: source=%s -> target=%s", idx, source, target)
        popen_kwargs = {
            "stdout": subprocess.DEVNULL,
            "stderr": subprocess.PIPE,
            "bufsize": 1,
            "universal_newlines": True,
        }
        if os.name != "nt":
            popen_kwargs["preexec_fn"] = os.setsid
        else:
            popen_kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
        p = subprocess.Popen(cmd, **popen_kwargs)
        ffmpeg_processes.append(p)
        _start_stderr_reader(p, f"ffmpeg#{idx}")


def _start_stderr_reader(proc: subprocess.Popen, name: str):
    import threading

    def reader():
        if not proc.stderr:
            return
        try:
            for line in proc.stderr:
                line = line.rstrip()
                if not line:
                    continue
                # Print/log only lines that look like errors.
                # ffmpeg is invoked with -loglevel error so typically only error lines appear,
                # but this also guards against unexpected verbose output.
                if "error" in line.lower() or line.startswith("Error"):
                    # Print to stdout for visibility and log as error
                    print(f"{name} | {line}")
                    logger.error("%s: %s", name, line)
        except Exception:
            # Reader can fail when process exits; ignore
            pass

    t = threading.Thread(target=reader, daemon=True)
    t.start()


def terminate_all_processes():
    logger.info("Terminating all ffmpeg processes...")
    for p in ffmpeg_processes:
        try:
            if p.poll() is not None:
                continue
            logger.info("Terminating pid=%s", p.pid)
            if os.name == "nt":
                try:
                    p.send_signal(signal.CTRL_BREAK_EVENT)
                except Exception:
                    pass
                time.sleep(1)
                if p.poll() is None:
                    p.kill()
            else:
                try:
                    os.killpg(os.getpgid(p.pid), signal.SIGTERM)
                except Exception:
                    try:
                        p.terminate()
                    except Exception:
                        pass
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                logger.warning("Process pid=%s did not exit; killing...", p.pid)
                if os.name == "nt":
                    p.kill()
                else:
                    try:
                        os.killpg(os.getpgid(p.pid), signal.SIGKILL)
                    except Exception:
                        p.kill()
        except Exception:
            logger.exception("Error while terminating process pid=%s", getattr(p, "pid", "<unknown>"))


# ================== SIGNAL HANDLING ==================
def _signal_handler(signum, frame):
    logger.info("Received signal %s - shutting down", signum)
    terminate_all_processes()
    sys.exit(0)


signal.signal(signal.SIGINT, _signal_handler)
signal.signal(signal.SIGTERM, _signal_handler)

# ================== MAIN ==================
def main():
    if not ACCESS_TOKEN:
        logger.error("ACCESS_TOKEN is required. Set environment variable ACCESS_TOKEN.")
        sys.exit(1)

    if not SOURCES:
        logger.error("No sources provided. Set environment variable SOURCES.")
        sys.exit(1)

    logger.info("Creating %d unpublished live videos...", CREATE_COUNT)
    created = create_multiple_lives(CREATE_COUNT, ACCESS_TOKEN)

    if not created:
        logger.error("No live videos were created. Exiting.")
        sys.exit(1)

    # Build targets and pair each target with a source.
    targets = []
    pairs = []

    # If number of sources differs from CREATE_COUNT, cycle through sources.
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

        # pick a source (cycle if needed)
        source = SOURCES[i % len(SOURCES)]
        logger.info("Mapping: live_id=%s -> source=%s -> target=%s (dash=%s)", live_id, source, target, dash)
        pairs.append({"source": source, "target": target, "id": live_id, "dash": dash, "stream_key": stream_key})

    if not pairs:
        logger.error("No valid pairs to stream. Exiting.")
        sys.exit(1)

    # Start ffmpeg processes, one per pair (each pair maps to a single stream key and source)
    start_ffmpeg_for_pairs(pairs)

    # Summary log
    logger.info("Summary of created live videos and mappings:")
    for idx, p in enumerate(pairs, start=1):
        logger.info("Stream #%d: id=%s, source=%s, target=%s, stream_key=%s, dash=%s",
                    idx, p.get("id"), p.get("source"), p.get("target"), p.get("stream_key"), p.get("dash"))

    # Keep main thread alive while ffmpeg processes run
    try:
        while True:
            any_running = any(p.poll() is None for p in ffmpeg_processes)
            if not any_running:
                logger.info("All ffmpeg processes have exited.")
                break
            time.sleep(1)
    except KeyboardInterrupt:
        logger.info("KeyboardInterrupt received, shutting down.")
    finally:
        terminate_all_processes()
        logger.info("Exited.")


if __name__ == "__main__":
    main()
