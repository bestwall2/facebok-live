#!/usr/bin/env python3
"""
Simple, robust FFmpeg streamer for two sources -> two RTMPS outputs.

Features:
- Starts two ffmpeg processes (one per source).
- Captures and logs ffmpeg stderr output.
- Handles SIGINT / SIGTERM for clean shutdown.
- Restarts a stream automatically if ffmpeg exits unexpectedly (with backoff).
- Uses process groups so all child processes are terminated on shutdown.
"""

import os
import sys
import time
import signal
import logging
import subprocess
import threading

# ================== CONFIG ==================
SOURCE_1 = "http://185.226.172.11:8080/mo3ad/mo3ad1.m3u8"
SOURCE_2 = "http://185.226.172.11:8080/mo3ad/mo3ad2.m3u8"

RTMPS_1 = "rtmps://live-api-s.facebook.com:443/rtmp/STREAM_KEY_1"
RTMPS_2 = "rtmps://live-api-s.facebook.com:443/rtmp/STREAM_KEY_2"

FFMPEG_PATH = "/usr/bin/ffmpeg"

# How many seconds to wait before restarting a failed stream (backoff will multiply)
RESTART_BASE_DELAY = 2
# Maximum backoff delay (seconds) between restarts
RESTART_MAX_DELAY = 60
# If you want unlimited restarts set this to None, otherwise an int
MAX_RESTARTS = None

# ================== LOGGING ==================
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("streamer")

# ================== FFMPEG COMMAND ==================
def build_ffmpeg_cmd(source, rtmps):
    return [
        FFMPEG_PATH,
        "-loglevel", "warning",
        "-re",
        "-fflags", "+genpts+igndts+nobuffer",
        "-flags", "low_delay",
        "-rw_timeout", "3000000",
        "-timeout", "3000000",
        "-reconnect", "1",
        "-reconnect_streamed", "1",
        "-reconnect_at_eof", "1",
        "-reconnect_delay_max", "5",
        "-thread_queue_size", "4096",
        "-user_agent", "Mozilla/5.0",
        "-i", source,
        # Mapping
        "-map", "0:v:0",
        "-map", "0:a:0?",
        # Video
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
        # Audio
        "-c:a", "aac",
        "-b:a", "128k",
        "-ac", "2",
        "-ar", "48000",
        # Output
        "-f", "flv",
        "-rtmp_live", "live",
        "-flvflags", "no_duration_filesize",
        rtmps
    ]

# ================== STREAM WORKER ==================
class StreamWorker:
    def __init__(self, name, source, rtmps):
        self.name = name
        self.source = source
        self.rtmps = rtmps
        self.process = None
        self._stop_event = threading.Event()
        self._reader_thread = None
        self._restart_count = 0

    def start(self):
        """Start the worker loop in a background thread."""
        t = threading.Thread(target=self._run_forever, daemon=True)
        t.start()

    def stop(self):
        """Signal the worker to stop and terminate the running process."""
        self._stop_event.set()
        self._terminate_process()

    def _run_forever(self):
        delay = RESTART_BASE_DELAY
        while not self._stop_event.is_set():
            logger.info("▶ Starting %s (attempt #%s)", self.name, self._restart_count + 1)
            try:
                self._start_process()
                # Wait until process ends or stop event is set
                while not self._stop_event.is_set():
                    ret = self.process.poll()
                    if ret is not None:
                        logger.warning("%s exited with code %s", self.name, ret)
                        break
                    time.sleep(0.5)
            except Exception as e:
                logger.exception("%s: exception while running ffmpeg: %s", self.name, e)
            finally:
                self._terminate_process()

            if self._stop_event.is_set():
                break

            # Handle restart logic
            self._restart_count += 1
            if (MAX_RESTARTS is not None) and (self._restart_count > MAX_RESTARTS):
                logger.error("%s: reached max restart limit (%s). Not restarting.", self.name, MAX_RESTARTS)
                break

            logger.info("%s: restarting in %s seconds...", self.name, delay)
            time.sleep(delay)
            delay = min(delay * 2, RESTART_MAX_DELAY)

    def _start_process(self):
        cmd = build_ffmpeg_cmd(self.source, self.rtmps)

        # Cross-platform process group creation
        popen_kwargs = {
            "stdout": subprocess.DEVNULL,
            "stderr": subprocess.PIPE,
            "bufsize": 1,
            "universal_newlines": True,
        }
        if os.name == "nt":
            # CREATE_NEW_PROCESS_GROUP lets us send CTRL_BREAK_EVENT on Windows if needed
            popen_kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
        else:
            # start new process group so we can kill the whole group (ffmpeg forks)
            popen_kwargs["preexec_fn"] = os.setsid

        self.process = subprocess.Popen(cmd, **popen_kwargs)
        logger.info("%s: ffmpeg started (pid=%s)", self.name, self.process.pid)

        # Start a reader thread to print ffmpeg stderr lines (non-blocking)
        self._reader_thread = threading.Thread(target=self._drain_stderr, daemon=True)
        self._reader_thread.start()

    def _drain_stderr(self):
        if not self.process or not self.process.stderr:
            return
        try:
            for line in self.process.stderr:
                line = line.rstrip()
                if line:
                    logger.debug("%s ffmpeg: %s", self.name, line)
        except Exception:
            # It's normal for reading to fail when process is terminated
            pass

    def _terminate_process(self):
        if not self.process:
            return

        logger.info("%s: terminating ffmpeg (pid=%s)...", self.name, self.process.pid)
        try:
            if os.name == "nt":
                # On Windows, try CTRL_BREAK_EVENT then kill
                try:
                    self.process.send_signal(signal.CTRL_BREAK_EVENT)
                except Exception:
                    pass
                time.sleep(1)
                if self.process.poll() is None:
                    self.process.kill()
            else:
                # Send SIGTERM to the process group
                try:
                    os.killpg(os.getpgid(self.process.pid), signal.SIGTERM)
                except Exception:
                    # fallback: kill single process
                    try:
                        self.process.terminate()
                    except Exception:
                        pass

            # Wait briefly for exit
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                logger.warning("%s: ffmpeg did not exit, killing...", self.name)
                try:
                    if os.name == "nt":
                        self.process.kill()
                    else:
                        os.killpg(os.getpgid(self.process.pid), signal.SIGKILL)
                except Exception:
                    pass
                try:
                    self.process.wait(timeout=2)
                except Exception:
                    pass
        except Exception:
            logger.exception("%s: error while terminating ffmpeg", self.name)
        finally:
            # Close stderr to stop reader thread
            try:
                if self.process.stderr:
                    self.process.stderr.close()
            except Exception:
                pass
            self.process = None

# ================== MAIN & SIGNALS ==================
workers = []

def shutdown(signum, frame):
    logger.info("🛑 Received signal %s — stopping streams...", signum)
    for w in workers:
        w.stop()

def main():
    # Create workers for each stream
    w1 = StreamWorker("Stream 1", SOURCE_1, RTMPS_1)
    w2 = StreamWorker("Stream 2", SOURCE_2, RTMPS_2)
    workers.extend([w1, w2])

    # Setup signal handlers
    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    # Start workers
    w1.start()
    w2.start()

    # Keep main thread alive until workers finish (they're daemon threads so exit on main exit)
    try:
        # Wait until all workers have stopped (poll every second).
        while True:
            # If all workers have no active process and stop was requested, exit.
            all_stopped = True
            for w in workers:
                if not w._stop_event.is_set():
                    all_stopped = False
                    break
            if all_stopped:
                break
            time.sleep(1)
    except KeyboardInterrupt:
        shutdown("KeyboardInterrupt", None)

    logger.info("All streams stopped. Exiting.")

if __name__ == "__main__":
    main()