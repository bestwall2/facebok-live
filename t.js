/******************************************************************
 * FACEBOOK MULTI STREAM MANAGER – CONTROL MODE (STREAM KEY + COPY + SAFE RESTART)
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
    "-c", "copy",   // passthrough audio+video
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
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
    return json;
  }
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
      const preview = await FacebookAPI.getPreview(item.streamId, item.token);
      item.preview = preview;
      const rawUrl = preview.secure_stream_url || preview.stream_url;
      const streamKey = extractStreamKey(rawUrl);
      if (!streamKey) throw new Error("No stream key available");
      item.rtmps = `rtmps://live-api-s.facebook.com:443/rtmp/${streamKey}`;
      const cmd = ffmpeg(item.source)
        .inputOptions(FACEBOOK_FFMPEG_OPTIONS.input)
        .outputOptions(FACEBOOK_FFMPEG_OPTIONS.output)
        .output(item.rtmps)
        .on("start", async (commandLine) => {
          Logger.success(`Stream started: ${item.name}`);
          fs.appendFileSync(`ffmpeg_${item.id}.cmd.txt`, commandLine + "\n");
          await Telegram.send(`✅ <b>LIVE</b>\n<b>${escapeHtml(item.name)}</b>\nRTMPS: ${item.rtmps}`);
        })
        .on("progress", () => {
          const streamInfo = activeStreams.get(item.id);
          if (streamInfo) streamInfo.lastOutput = Date.now();
        })
        .on("stderr", (stderrLine) => {
          fs.appendFileSync(`ffmpeg_${item.id}.log`, `[${new Date().toISOString()}] ${stderrLine}\n`);
        })
        .on("error", (err) => {
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
    if (systemState !== "running") {
      try { activeStreams.get(item.id)?.command?.kill("SIGKILL"); } catch {}
      activeStreams.delete(item.id);
      return;
    }
    const retries = (streamRetries.get(item.id) || 0) + 1;
    streamRetries.set(item.id, retries);
    if (retries <= CONFIG.maxRetries) {
      Logger.warn(`Retry ${item.name} (${retries}/${CONFIG.maxRetries})`);
      await StreamManager.restartSingle(item);
      return;
    }
    Logger.error(`Stream stopped permanently: ${item.name}`);
    await Telegram.send(`❌ LIVE STOPPED\n${item.name}\n${reason}`);
    try { activeStreams.get(item.id)?.command?.kill("SIGKILL"); } catch {}
    activeStreams.delete(item.id);
  }
  static async restartSingle(item) {
    try { activeStreams.get(item.id)?.command?.kill("SIGKILL"); } catch {}
    activeStreams.delete(item.id);
    try {
      const live = await FacebookAPI.createLive(item.token, item.name);
      item.streamId = live.id;
      await new Promise(r => setTimeout(r, 3000));
      await StreamManager.startFFmpeg(item);
    } catch (e) {
      Logger.error(`Failed to restart ${item.name}: ${e.message}`);
    }
  }
  static stopAll() {
    Logger.info(`Stopping ${activeStreams.size} active streams`);
    activeStreams.forEach((s) => { try { s.command?.kill("SIGKILL"); } catch {} });
    activeStreams.clear();
    streamRetries.clear();
  }
}

class System {
  static async fetchStreams() {
    const response = await fetch(CONFIG.streamsApi);
    const json = await response.json();
    const map = new Map();
    json.data.forEach((item, i) => {
      map.set(`item_${i}`, { id: `item_${i}`, token: item.token, name: item.name, source: item.source });
    });
    return map;
  }
  static async start() {
    if (systemState === "running") return Logger.warn("System already running");
    systemState = "running"; startTime = Date.now();
    Logger.success("SYSTEM START"); await Telegram.send("▶ <b>SYSTEM STARTED</b>");
    try {
      allItems = await this.fetchStreams();
      for (const item of allItems.values()) {
        if (systemState !== "running")
