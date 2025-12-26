#!/usr/bin/env python3
"""
Stream a single source to 3 Facebook live-stream endpoints that are created
via the Graph API as unpublished live videos.

What this script does:
- Creates N unpublished live videos via Graph API (/me/live_videos?published=false)
- Reads each returned live-video ID and fetches fields: stream_url, stream_key, dash_preview_url
- Starts one ffmpeg process per live video using the same SOURCE
- Logs detailed information about API responses, IDs, dash preview URLs and stream keys
- Handles SIGINT/SIGTERM for a clean shutdown of ffmpeg processes

Requirements:
- Python 3.7+
- requests library: pip install requests

Usage:
- Export your Facebook access token in env var ACCESS_TOKEN or set ACCESS_TOKEN below.
- Adjust SOURCE and FFMPEG_PATH as needed.
- Run: python3 stream_fb_multi.py
"""

import os
import sys
import time
import signal
import logging
import subprocess
from typing import List, Dict, Optional

try:
    import requests
except Exception as e:
    print("Missing dependency 'requests'. Install with: pip install requests")
    raise

# ================== CONFIG ==================
# Single source to stream to all created live videos
SOURCE = os.getenv("SOURCE", "http://185.226.172.11:8080/mo3ad/mo3ad1.m3u8")

# Facebook access token (user or page token with live_video permission)
ACCESS_TOKEN = os.getenv("ACCESS_TOKEN", "EAAKXMxkBFCIBQXuVhGhiDHmzP94DK2mp0BQQZC7Jel2ybOiDg99yKKTIFZCE8PmfmgaLIvBODGgISEqy8SZCMqjYKw7ZBb1oWZCtJj9t97jssSWBkAOp5xdYwVtzQ9skg1uKEEkxZCpWw3XWZCMhMqlpxZC5JxkemvLvBACFFwhbvRvh5mnOTRn52KkyFUcjy4GHnl9TwLqv0igqOUutjZBl1HuIZD")

# Graph API base and version
FB_API_VERSION = os.getenv("FB_API_VERSION", "v24.0")
FB_GRAPH_BASE = f"https://graph.facebook.com/{FB_API_VERSION}"

# How many unpublished live videos to create (3 per request)
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

# ffmpeg common options (kept simple and reliable)
def build_ffmpeg_cmd(source: str, rtmp_target: str) -> List[str]:
    return [
        FFMPEG_PATH,
        "-loglevel", "warning",
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
    """
    Create an unpublished live video. Returns JSON response (should contain 'id').
    We call POST /me/live_videos with published=false. If your token requires a page
    context, use /{page-id}/live_videos instead (not implemented here).
    """
    url = f"{FB_GRAPH_BASE}/me/live_videos"
    params = {
        "access_token": access_token,
        "published": "false",  # request an unpublished live video
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
    """
    Fetch stream_url, stream_key, dash_preview_url and other useful fields for a created live video.
    """
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
    """
    Create `count` unpublished live videos and collect their details.
    Returns list of dicts containing at least: id, stream_url, stream_key, dash_preview_url
    """
    created = []
    for i in range(1, count + 1):
        title = f"AutoStream #{i} - created by script"
        try:
            created_resp = create_unpublished_live(access_token, title=title)
            live_id = created_resp.get("id")
            if not live_id:
                logger.error("No 'id' in create response: %s", created_resp)
                raise RuntimeError("Missing id in create response")
            # fetch additional details
            details = fetch_live_details(live_id, access_token)
            # Some Graph versions return "stream_url" containing RTMP + key; others return "stream_key"
            stream_url = details.get("stream_url") or details.get("secure_stream_url")
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
            # continue to next so we attempt to create remaining streams
    return created


# ================== STREAM PROCESS MANAGEMENT ==================
ffmpeg_processes: List[subprocess.Popen] = []


def start_ffmpeg_for_targets(source: str, targets: List[str]) -> None:
    """
    Start ffmpeg processes streaming `source` to each `target` (rtmp/rtmps URL).
    We capture stderr for logging and start processes in their own process groups.
    """
    for idx, target in enumerate(targets, start=1):
        cmd = build_ffmpeg_cmd(source, target)
        logger.info("Starting ffmpeg #%d -> %s", idx, target)
        # Start in new process group so termination is easier
        popen_kwargs = {
            "stdout": subprocess.DEVNULL,
            "stderr": subprocess.PIPE,
            "bufsize": 1,
            "universal_newlines": True,
            # use preexec_fn=os.setsid on POSIX to create new process group
        }
        if os.name != "nt":
            popen_kwargs["preexec_fn"] = os.setsid
        else:
            popen_kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
        p = subprocess.Popen(cmd, **popen_kwargs)
        ffmpeg_processes.append(p)
        # Start a thread to read stderr lines
        _start_stderr_reader(p, f"ffmpeg#{idx}")


def _start_stderr_reader(proc: subprocess.Popen, name: str):
    import threading

    def reader():
        if not proc.stderr:
            return
        try:
            for line in proc.stderr:
                line = line.rstrip()
                if line:
                    # Use debug level for verbose ffmpeg output, info for notable lines
                    logger.debug("%s: %s", name, line)
                    # Also print some lines to stdout to help interactive monitoring
                    print(f"{name} | {line}")
        except Exception:
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
    # Let the signal kill or exit gracefully
    sys.exit(0)


signal.signal(signal.SIGINT, _signal_handler)
signal.signal(signal.SIGTERM, _signal_handler)


# ================== MAIN ==================
def main():
    if not ACCESS_TOKEN:
        logger.error("ACCESS_TOKEN is required. Set environment variable ACCESS_TOKEN or modify the script.")
        sys.exit(1)

    logger.info("Starting creation of %d unpublished live videos", CREATE_COUNT)
    created = create_multiple_lives(CREATE_COUNT, ACCESS_TOKEN)

    if not created:
        logger.error("No live videos were created. Exiting.")
        sys.exit(1)

    # Build rtmp/rtmps targets from returned details.
    targets = []
    for i, entry in enumerate(created, start=1):
        live_id = entry.get("id")
        stream_url = entry.get("stream_url")
        stream_key = entry.get("stream_key")

        # Prefer full stream_url if provided; otherwise build using rtmps + stream_key
        if stream_url:
            target = stream_url
        elif stream_key:
            # standard facebook rtmps endpoint
            target = f"rtmps://live-api-s.facebook.com:443/rtmp/{stream_key}"
        else:
            logger.error("No stream_url or stream_key for id=%s. Skipping this target.", live_id)
            continue

        logger.info("Target #%d -> id=%s target=%s dash_preview=%s", i, live_id, target, entry.get("dash_preview_url"))
        targets.append(target)

    if not targets:
        logger.error("No valid RTMP targets to stream to. Exiting.")
        sys.exit(1)

    # Start ffmpeg processes (one per target)
    start_ffmpeg_for_targets(SOURCE, targets)

    # Print summary (IDs, keys, dash URLs)
    logger.info("Summary of created live videos:")
    for idx, entry in enumerate(created, start=1):
        logger.info(
            "Live #%d: id=%s, stream_url=%s, stream_key=%s, dash_preview=%s",
            idx,
            entry.get("id"),
            entry.get("stream_url"),
            entry.get("stream_key"),
            entry.get("dash_preview_url"),
        )

    # Keep main thread alive while ffmpeg processes run
    try:
        while True:
            still_running = False
            for p in ffmpeg_processes:
                if p.poll() is None:
                    still_running = True
            if not still_running:
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
