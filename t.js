/******************************************************************
 * FACEBOOK MULTI STREAM MANAGER – CONTROL MODE (FIXED)
 ******************************************************************/

import fs from "fs";
import ffmpeg from "fluent-ffmpeg";
import fetch from "node-fetch";

const CONFIG = {
  streamsApi: "https://ani-box-nine.vercel.app/api/grok-chat",
  controlApi: "https://ovubovyckalyentrgahb.supabase.co/rest/v1/isState",
  controlToken: "sb_publishable_D1BH-HDP_S_myTuLK_q0gg_LbWZ0g5K",
  controlPollInterval: 20000,
  healthCheckInterval: 30000,
  reportInterval: 300000,
  maxRetries: 1,
  restartDelay: 10000,
  globalRestartAfter: 13500000,
  telegram: {
    botToken: "7971806903:AAHwpdNzkk6ClL3O17JVxZnp5e9uI66L9WE",
    chatId: "-1002181683719"
  }
};

const CONTROL_HEADERS = {
  apikey: CONFIG.controlToken,
  Authorization: `Bearer ${CONFIG.controlToken}`
};

const FACEBOOK_FFMPEG_OPTIONS = {
  input: [
    "-re",
    "-fflags", "+genpts",
    "-avoid_negative_ts", "make_zero",
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_delay_max", "5",
    "-user_agent", "Mozilla/5.0"
  ],
  output: [
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-tune", "zerolatency",
    "-profile:v", "high",
    "-level", "4.1",
    "-pix_fmt", "yuv420p",
    "-r", "30",
    "-g", "60",
    "-keyint_min", "60",
    "-sc_threshold", "0",
    "-bf", "2",
    "-b:v", "4500k",
    "-maxrate", "4500k",
    "-bufsize", "9000k",
    "-c:a", "aac",
    "-b:a", "128k",
    "-ar", "44100",
    "-ac", "2",
    "-f", "flv",
    "-flvflags", "no_duration_filesize"
  ]
};

let allItems = new Map();
let activeStreams = new Map();
let streamRetries = new Map();
let systemState = "stopped";
let lastProcessedAction = null;
let lastProcessedId = null;
let globalRestartTimer = null;
let controlPollTimer = null;
let healthCheckTimer = null;
let reportTimer = null;
let startTime = Date.now();
let isProcessingAction = false;

class Logger {
  static log(level, message) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] [${level}] ${message}`;
    console.log(line);
    try {
      fs.appendFileSync("system.log", line + "\n");
    } catch (e) {
      // Ignore write errors
    }
  }

  static info(message) {
    this.log("INFO", message);
  }

  static warn(message) {
    this.log("WARN", message);
  }

  static error(message) {
    this.log("ERROR", message);
  }

  static success(message) {
    this.log("SUCCESS", message);
  }
}

class Telegram {
  static async send(text) {
    try {
      const url = `https://api.telegram.org/bot${CONFIG.telegram.botToken}/sendMessage`;
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: CONFIG.telegram.chatId,
          text: text,
          parse_mode: "HTML"
        })
      });
    } catch (err) {
      Logger.error("Telegram send error: " + err.message);
    }
  }
}

class FacebookAPI {
  static async createLive(token, name) {
    const url = "https://graph.facebook.com/v24.0/me/live_videos";
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: name,
        status: "UNPUBLISHED",
        access_token: token
      })
    });
    const json = await res.json();
    if (json.error) {
      throw new Error(json.error.message || JSON.stringify(json.error));
    }
    return { id: json.id };
  }

  static async getPreview(liveId, token) {
    try {
      const fields = "status,stream_url,secure_stream_url,dash_preview_url,permalink_url,embed_html";
      const url = `https://graph.facebook.com/v24.0/${liveId}?fields=${fields}&access_token=${encodeURIComponent(token)}`;
      const res = await fetch(url);
      const json = await res.json();
      if (json.error) {
        throw new Error(json.error.message || JSON.stringify(json.error));
      }
      return {
        status: json.status || null,
        stream_url: json.stream_url || null,
        secure_stream_url: json.secure_stream_url || null,
        dash_preview_url: json.dash_preview_url || null,
        permalink_url: json.permalink_url || null,
        embed_html: json.embed_html || null
      };
    } catch (e) {
      throw new Error("Facebook preview fetch failed: " + e.message);
    }
  }
}

function extractMPDFromPreview(preview) {
  if (!preview) return null;
  const candidates = [
    preview.dash_preview_url,
    preview.secure_stream_url,
    preview.stream_url,
    preview.permalink_url
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (candidate.includes(".mpd")) return candidate;
      if (candidate.includes("dash") || candidate.includes("manifest") || candidate.includes("mpd")) {
        return candidate;
      }
    } catch (e) {
      continue;
    }
  }
  return null;
}

function escapeHtml(text) {
  if (!text) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

class StreamManager {
  static async startFFmpeg(item) {
    Logger.info(`Starting stream: ${item.name}`);

    try {
      const preview = await FacebookAPI.getPreview(item.streamId, item.token);
      item.preview = preview;
      item.rtmps = preview.stream_url || preview.secure_stream_url;
      
      if (!item.rtmps) {
        throw new Error("No RTMPS URL available");
      }

      const cmd = ffmpeg(item.source)
        .inputOptions(FACEBOOK_FFMPEG_OPTIONS.input)
        .outputOptions(FACEBOOK_FFMPEG_OPTIONS.output)
        .output(item.rtmps)
        .on("start", async (commandLine) => {
          Logger.success(`Stream started: ${item.name}`);
          fs.appendFileSync(`ffmpeg_${item.id}.cmd.txt`, commandLine + "\n");

          const mpd = extractMPDFromPreview(preview) || "N/A";
          const msg = `✅ <b>LIVE</b>\n<b>${escapeHtml(item.name)}</b>\nChannel: ${preview.permalink_url || "N/A"}\nDASH preview (MPD): ${mpd}\nRTMPS: ${item.rtmps}`;
          await Telegram.send(msg);
        })
        .on("progress", () => {
          const streamInfo = activeStreams.get(item.id);
          if (streamInfo) {
            streamInfo.lastOutput = Date.now();
          }
        })
        .on("stderr", (stderrLine) => {
          const logLine = `[${new Date().toISOString()}] ${stderrLine}\n`;
          fs.appendFileSync(`ffmpeg_${item.id}.log`, logLine);
        })
        .on("error", (err) => {
          Logger.error(`Stream error ${item.name}: ${err.message}`);
          StreamManager.handleFailure(item, err.message);
        })
        .on("end", () => {
          Logger.warn(`Stream ended: ${item.name}`);
          StreamManager.handleFailure(item, "Stream ended");
        });

      activeStreams.set(item.id, {
        command: cmd,
        item: item,
        lastOutput: Date.now()
      });

      cmd.run();

    } catch (e) {
      Logger.error(`Failed to get RTMPS URL for ${item.name}: ${e.message}`);
      await StreamManager.handleFailure(item, e.message);
    }
  }

  static async handleFailure(item, reason) {
    if (systemState !== "running") {
      const streamInfo = activeStreams.get(item.id);
      try {
        if (streamInfo && streamInfo.command) {
          streamInfo.command.kill("SIGKILL");
        }
      } catch (e) {
        // Ignore
      }
      activeStreams.delete(item.id);
      return;
    }

    const retries = streamRetries.get(item.id) || 0;
    const newRetries = retries + 1;
    streamRetries.set(item.id, newRetries);

    if (newRetries <= CONFIG.maxRetries && systemState === "running") {
      Logger.warn(`Retry ${item.name} (${newRetries}/${CONFIG.maxRetries})`);
      await StreamManager.restartSingle(item);
      return;
    }

    Logger.error(`Stream stopped permanently: ${item.name}`);
    await Telegram.send(`❌ LIVE STOPPED\n${item.name}\n${reason}`);
    
    const streamInfo = activeStreams.get(item.id);
    try {
      if (streamInfo && streamInfo.command) {
        streamInfo.command.kill("SIGKILL");
      }
    } catch (e) {
      // Ignore
    }
    activeStreams.delete(item.id);
  }

  static async restartSingle(item) {
    const streamInfo = activeStreams.get(item.id);
    try {
      if (streamInfo && streamInfo.command) {
        streamInfo.command.kill("SIGKILL");
      }
    } catch (e) {
      // Ignore
    }
    activeStreams.delete(item.id);

    try {
      const live = await FacebookAPI.createLive(item.token, item.name);
      item.streamId = live.id;
      await new Promise(resolve => setTimeout(resolve, 3000));
      await StreamManager.startFFmpeg(item);
    } catch (e) {
      Logger.error(`Failed to restart ${item.name}: ${e.message}`);
    }
  }

  static stopAll() {
    Logger.info(`Stopping ${activeStreams.size} active streams`);
    activeStreams.forEach((streamInfo) => {
      try {
        if (streamInfo.command) {
          streamInfo.command.kill("SIGKILL");
        }
      } catch (e) {
        Logger.error(`Error killing stream: ${e.message}`);
      }
    });
    activeStreams.clear();
    streamRetries.clear();
  }
}

class System {
  static async fetchStreams() {
    const response = await fetch(CONFIG.streamsApi);
    const json = await response.json();
    const map = new Map();
    json.data.forEach((item, index) => {
      map.set(`item_${index}`, {
        id: `item_${index}`,
        token: item.token,
        name: item.name,
        source: item.source
      });
    });
    return map;
  }

  static async start() {
    if (systemState === "running") {
      Logger.warn("System already running");
      return;
    }

    systemState = "running";
    startTime = Date.now();
    Logger.success("SYSTEM START");
    await Telegram.send("▶ <b>SYSTEM STARTED</b>");

    try {
      allItems = await this.fetchStreams();

      for (const item of allItems.values()) {
        if (systemState !== "running") break;

        const live = await FacebookAPI.createLive(item.token, item.name);
        item.streamId = live.id;
        await StreamManager.startFFmpeg(item);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      try {
        await waitForAllStartedOrTimeout(allItems.size, 30000);
        await System.sendPreviewReport();
      } catch (e) {
        Logger.warn("Preview report: " + e.message);
        await System.sendPreviewReport();
      }

      if (globalRestartTimer) {
        clearTimeout(globalRestartTimer);
      }
      globalRestartTimer = setTimeout(() => {
        System.restart("Scheduled 3h45m restart");
      }, CONFIG.globalRestartAfter);

    } catch (e) {
      Logger.error(`System start failed: ${e.message}`);
      await Telegram.send(`❌ <b>SYSTEM START FAILED</b>\n${escapeHtml(e.message)}`);
      systemState = "stopped";
    }
  }

  static async stop(reason) {
    if (!reason) reason = "Manual stop";
    
    if (systemState === "stopped") {
      Logger.warn("System already stopped");
      return;
    }

    Logger.warn("SYSTEM STOP");
    systemState = "stopped";

    if (globalRestartTimer) {
      clearTimeout(globalRestartTimer);
      globalRestartTimer = null;
    }

    StreamManager.stopAll();

    await Telegram.send(`⛔ <b>SYSTEM STOPPED</b>\n${escapeHtml(reason)}`);
    Logger.success("System stopped successfully");
  }

  static async restart(reason) {
    if (isProcessingAction) {
      Logger.warn("Already processing action, ignoring restart");
      return;
    }

    Logger.warn("SYSTEM RESTART");
    await Telegram.send(`♻ <b>SYSTEM RESTART</b>\n${escapeHtml(reason)}`);

    systemState = "restarting";
    StreamManager.stopAll();

    if (globalRestartTimer) {
      clearTimeout(globalRestartTimer);
      globalRestartTimer = null;
    }

    setTimeout(async () => {
      await System.start();
    }, CONFIG.restartDelay);
  }

  static async sendPreviewReport() {
    const lines = [];
    for (const item of allItems.values()) {
      let preview = item.preview;
      if (!preview && item.streamId) {
        try {
          preview = await FacebookAPI.getPreview(item.streamId, item.token);
          item.preview = preview;
        } catch (e) {
          preview = null;
        }
      }
      const mpd = extractMPDFromPreview(preview) || "N/A";
      const rtmps = (preview && (preview.stream_url || preview.secure_stream_url)) || "N/A";
      const permalink = (preview && preview.permalink_url) || "N/A";
      lines.push(`<b>${escapeHtml(item.name)}</b>\nChannel: ${permalink}\nDASH: ${mpd}\nRTMPS: ${rtmps}`);
    }
    const text = `📡 <b>LIVE PREVIEW REPORT</b>\n\n${lines.join("\n\n")}`;
    await Telegram.send(text);
    Logger.info("Preview report sent to telegram");
  }
}

async function waitForAllStartedOrTimeout(expectedCount, timeoutMs) {
  const startWait = Date.now();
  while ((Date.now() - startWait) < timeoutMs) {
    if (activeStreams.size >= expectedCount) return;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error("Timeout waiting for all ffmpeg processes to start");
}

async function pollControlAPI() {
  if (isProcessingAction) {
    Logger.info("Already processing action, skipping poll");
    return;
  }

  try {
    const url = CONFIG.controlApi + "?select=id,Action&order=id.desc&limit=1";
    const response = await fetch(url, { headers: CONTROL_HEADERS });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const json = await response.json();

    if (!json || json.length === 0) {
      Logger.warn("No data from control API");
      return;
    }

    const record = json[0];
    const action = record && record.Action ? record.Action.toLowerCase() : null;
    const id = record && record.id ? record.id : null;

    if (lastProcessedId === id && lastProcessedAction === action) {
      return;
    }

    Logger.info(`Control API: action="${action}", id=${id}, current state="${systemState}"`);

    if (!action) {
      Logger.warn("No action in control API response");
      return;
    }

    isProcessingAction = true;

    try {
      if (action === "start" && systemState !== "running") {
        await System.start();
        lastProcessedAction = action;
        lastProcessedId = id;
      } else if (action === "stop" && systemState !== "stopped") {
        await System.stop("Supabase Control API");
        lastProcessedAction = action;
        lastProcessedId = id;
      } else if (action === "restart") {
        await System.restart("Supabase Control API");
        lastProcessedAction = action;
        lastProcessedId = id;
      }
    } finally {
      isProcessingAction = false;
    }

  } catch (err) {
    Logger.error("Control API poll error: " + err.message);
    isProcessingAction = false;
  }
}

function healthCheck() {
  if (systemState !== "running") return;

  const now = Date.now();
  activeStreams.forEach((streamInfo) => {
    if (now - streamInfo.lastOutput > 60000) {
      Logger.warn(`Stream ${streamInfo.item.name} unhealthy - no output for 60s`);
      StreamManager.handleFailure(streamInfo.item, "No output 60s");
    }
  });
}

async function statusReport() {
  if (systemState !== "running") return;

  const uptimeMinutes = Math.floor((Date.now() - startTime) / 60000);
  await Telegram.send(`📡 STATUS\nState: ${systemState}\nUptime: ${uptimeMinutes} min\nActive: ${activeStreams.size}/${allItems.size}`);
}

function startIntervals() {
  if (controlPollTimer) clearInterval(controlPollTimer);
  if (healthCheckTimer) clearInterval(healthCheckTimer);
  if (reportTimer) clearInterval(reportTimer);

  controlPollTimer = setInterval(pollControlAPI, CONFIG.controlPollInterval);
  healthCheckTimer = setInterval(healthCheck, CONFIG.healthCheckInterval);
  reportTimer = setInterval(statusReport, CONFIG.reportInterval);

  Logger.success("Intervals started");
}

process.on("SIGINT", async () => {
  Logger.warn("Received SIGINT, shutting down gracefully...");

  if (controlPollTimer) clearInterval(controlPollTimer);
  if (healthCheckTimer) clearInterval(healthCheckTimer);
  if (reportTimer) clearInterval(reportTimer);
  if (globalRestartTimer) clearTimeout(globalRestartTimer);

  await System.stop("Process shutdown");
  process.exit(0);
});

process.on("SIGTERM", async () => {
  Logger.warn("Received SIGTERM, shutting down gracefully...");

  if (controlPollTimer) clearInterval(controlPollTimer);
  if (healthCheckTimer) clearInterval(healthCheckTimer);
  if (reportTimer) clearInterval(reportTimer);
  if (globalRestartTimer) clearTimeout(globalRestartTimer);

  await System.stop("Process shutdown");
  process.exit(0);
});

Logger.success("SYSTEM READY - WAITING FOR START");
startIntervals();
pollControlAPI();

export default System;