/******************************************************************
 * FACEBOOK MULTI STREAM MANAGER – CONTROL MODE
 * STREAM KEY EXTRACT + -c copy + SAFE STOP + INDEPENDENT RETRY
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
    "-user_agent", "Mozilla/5.0"
  ],
  output: [
    "-c", "copy",
    "-f", "flv",
    "-flvflags", "no_duration_filesize"
  ]
};

let allItems = new Map();
let activeStreams = new Map();
let systemState = "stopped";
let lastProcessedAction = null;
let lastProcessedId = null;
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
    try { fs.appendFileSync("system.log", line + "\n"); } catch {}
  }
  static info(m) { this.log("INFO", m); }
  static warn(m) { this.log("WARN", m); }
  static error(m) { this.log("ERROR", m); }
  static success(m) { this.log("SUCCESS", m); }
}

class Telegram {
  static async send(text) {
    try {
      const url = `https://api.telegram.org/bot${CONFIG.telegram.botToken}/sendMessage`;
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: CONFIG.telegram.chatId, text, parse_mode: "HTML" })
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
      body: JSON.stringify({ title: name, status: "UNPUBLISHED", access_token: token })
    });
    const json = await res.json();
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
    return { id: json.id };
  }

  static async getPreview(liveId, token) {
    const fields = "status,stream_url,secure_stream_url,dash_preview_url,permalink_url,embed_html";
    const url = `https://graph.facebook.com/v24.0/${liveId}?fields=${fields}&access_token=${encodeURIComponent(token)}`;
    const res = await fetch(url);
    const json = await res.json();
    consol.log(json);
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
    return {
      status: json.status ?? null,
      stream_url: json.stream_url ?? null,
      secure_stream_url: json.secure_stream_url ?? null,
      dash_preview_url: json.dash_preview_url ?? null,
      permalink_url: json.permalink_url ?? null,
      embed_html: json.embed_html ?? null
    };
  }
}

function extractMPDFromPreview(preview) {
  if (!preview) return null;
  const candidates = [preview.dash_preview_url, preview.secure_stream_url, preview.stream_url, preview.permalink_url];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate.includes(".mpd") || candidate.includes("dash") || candidate.includes("manifest")) return candidate;
  }
  return null;
}

function extractStreamKey(url) {
  if (!url) return null;
  const parts = url.split("/");
  return parts[parts.length - 1] || null;
}

function escapeHtml(text) {
  if (!text) return "";
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

class StreamManager {
  static async startFFmpeg(item) {
    Logger.info(`Starting stream: ${item.name}`);
    try {
      await new Promise(r => setTimeout(r, 2000));
      const preview = await FacebookAPI.getPreview(item.streamId, item.token);
      item.preview = preview;
      Logger.info(`Starting stream: ${preview}`);
      const rawUrl = preview.stream_url;
      consol.log(preview);
      //const streamKey = preview.stream_url;
      if (!streamKey) throw new Error("No stream key available");
      item.rtmps = rawUrl;

      const cmd = ffmpeg(item.source)
        .inputOptions(FACEBOOK_FFMPEG_OPTIONS.input)
        .outputOptions(FACEBOOK_FFMPEG_OPTIONS.output)
        .output(rawUrl)
        .on("start", async commandLine => {
          Logger.success(`Stream started: ${item.name}`);
          fs.appendFileSync(`ffmpeg_${item.id}.cmd.txt`, commandLine + "\n");
          const mpd = extractMPDFromPreview(preview) || "N/A";
          const msg = `✅ <b>LIVE</b>\n<b>${escapeHtml(item.name)}</b>\nChannel: ${preview.permalink_url || "N/A"}\nDASH preview (MPD): ${mpd}\nRTMPS: ${item.rtmps}`;
          await Telegram.send(msg);
        })
        .on("progress", () => {
          const streamInfo = activeStreams.get(item.id);
          if (streamInfo) streamInfo.lastOutput = Date.now();
        })
        .on("stderr", line => fs.appendFileSync(`ffmpeg_${item.id}.log`, `[${new Date().toISOString()}] ${line}\n`))
        .on("error", err => {
          Logger.error(`Stream error ${item.name}: ${err.message}`);
          StreamManager.handleFailure(item, err.message);
        })
        .on("end", () => {
          Logger.warn(`Stream ended: ${item.name}`);
          StreamManager.handleFailure(item, "Stream ended");
        });

      activeStreams.set(item.id, { command: cmd, item, lastOutput: Date.now() });
      cmd.run();
    } catch (e) {
      Logger.error(`Failed to start ${item.name}: ${e.message}`);
      await StreamManager.handleFailure(item, e.message);
    }
  }

  static async handleFailure(item, reason) {
    if (systemState !== "running") return;

    const streamInfo = activeStreams.get(item.id);
    try { streamInfo?.command?.kill("SIGKILL"); } catch {}
    activeStreams.delete(item.id);

    Logger.warn(`Stream ${item.name} stopped: ${reason}. Will retry in 1 minute.`);

    setTimeout(async () => {
      if (systemState !== "running") return;
      try { await StreamManager.startFFmpeg(item); } catch (e) {
        Logger.error(`Retry failed for ${item.name}: ${e.message}`);
      }
    }, 60000); // 1 minute
  }

  static stopAll() {
    Logger.info(`Stopping ${activeStreams.size} active streams`);
    activeStreams.forEach(streamInfo => {
      try { streamInfo.command?.kill("SIGKILL"); } catch (e) {
        Logger.error(`Error killing stream: ${e.message}`);
      }
    });
    activeStreams.clear();
  }
}

class System {
  static async fetchStreams() {
    const response = await fetch(CONFIG.streamsApi);
    const json = await response.json();
    const map = new Map();
    json.data.forEach((item, index) => {
      map.set(`item_${index}`, { id: `item_${index}`, token: item.token, name: item.name, source: item.source });
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
        await new Promise(r => setTimeout(r, 2000));
      }
      await System.sendPreviewReport();
    } catch (e) {
      Logger.error(`System start failed: ${e.message}`);
      await Telegram.send(`❌ <b>SYSTEM START FAILED</b>\n${escapeHtml(e.message)}`);
      systemState = "stopped";
    }
  }

  static async stop(reason) {
    if (!reason) reason = "Manual stop";
    if (systemState === "stopped") return;
    Logger.warn("SYSTEM STOP");
    systemState = "stopped";

    StreamManager.stopAll();
    await Telegram.send(`⛔ <b>SYSTEM STOPPED</b>\n${escapeHtml(reason)}`);
    Logger.success("System stopped successfully");
  }

  static async sendPreviewReport() {
    const lines = [];
    for (const item of allItems.values()) {
      let preview = item.preview;
      if (!preview && item.streamId) {
        try { preview = await FacebookAPI.getPreview(item.streamId, item.token); item.preview = preview; } catch {}
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

async function pollControlAPI() {
  if (isProcessingAction) return;
  isProcessingAction = true;
  try {
    const url = CONFIG.controlApi + "?select=id,Action&order=id.desc&limit=1";
    const response = await fetch(url, { headers: CONTROL_HEADERS });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    const json = await response.json();
    if (!json || json.length === 0) return;

    const record = json[0];
    const action = record?.Action?.toLowerCase();
    const id = record?.id;

    if (lastProcessedId === id && lastProcessedAction === action) return;
    Logger.info(`Control API: action="${action}", id=${id}, current state="${systemState}"`);

    if (action === "start" && systemState !== "running") {
      await System.start();
      lastProcessedAction = action;
      lastProcessedId = id;
    } else if (action === "stop" && systemState !== "stopped") {
      await System.stop("Supabase Control API");
      lastProcessedAction = action;
      lastProcessedId = id;
    }
  } catch (err) {
    Logger.error("Control API poll error: " + err.message);
  } finally {
    isProcessingAction = false;
  }
}

function healthCheck() {
  if (systemState !== "running") return;
  const now = Date.now();
  activeStreams.forEach(streamInfo => {
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
  await System.stop("Process shutdown");
  process.exit(0);
});

process.on("SIGTERM", async () => {
  Logger.warn("Received SIGTERM, shutting down gracefully...");
  if (controlPollTimer) clearInterval(controlPollTimer);
  if (healthCheckTimer) clearInterval(healthCheckTimer);
  if (reportTimer) clearInterval(reportTimer);
  await System.stop("Process shutdown");
  process.exit(0);
});

Logger.success("SYSTEM READY - WAITING FOR START");
startIntervals();
pollControlAPI();

export default System;
