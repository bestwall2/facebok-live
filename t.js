/******************************************************************
 * FACEBOOK MULTI STREAM MANAGER
 * - stream_url extracted ONCE
 * - cached & reused on restart
 * - no ffmpeg reconnect
 * - independent restart after 1 minute
 ******************************************************************/

import fs from "fs";
import ffmpeg from "fluent-ffmpeg";
import fetch from "node-fetch";

/* ================= CONFIG ================= */

const CONFIG = {
  streamsApi: "https://ani-box-nine.vercel.app/api/grok-chat",
  controlApi: "https://ovubovyckalyentrgahb.supabase.co/rest/v1/isState",
  controlToken: "sb_publishable_D1BH-HDP_S_myTuLK_q0gg_LbWZ0g5K",
  controlPollInterval: 20000,
  healthCheckInterval: 30000,
  telegram: {
    botToken: "7971806903:AAHwpdNzkk6ClL3O17JVxZnp5e9uI66L9WE",
    chatId: "-1002181683719"
  }
};

const CACHE_FILE = "./streams_cache.json";

/* ================= STATE ================= */

let allItems = new Map();
let activeStreams = new Map();
let streamUrlCache = new Map();
let systemState = "stopped";

/* ================= CACHE ================= */

function loadCache() {
  if (!fs.existsSync(CACHE_FILE)) return;
  try {
    const json = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    for (const k in json) streamUrlCache.set(k, json[k]);
    console.log("Cache loaded:", [...streamUrlCache.keys()]);
  } catch (e) {
    console.error("Cache load error:", e.message);
  }
}

function saveCache() {
  const obj = {};
  streamUrlCache.forEach((v, k) => (obj[k] = v));
  fs.writeFileSync(CACHE_FILE, JSON.stringify(obj, null, 2));
}

/* ================= LOGGER ================= */

class Logger {
  static log(level, msg) {
    console.log(`[${new Date().toISOString()}] [${level}] ${msg}`);
  }
  static info(m) { this.log("INFO", m); }
  static warn(m) { this.log("WARN", m); }
  static error(m) { this.log("ERROR", m); }
  static success(m) { this.log("SUCCESS", m); }
}

/* ================= TELEGRAM ================= */

class Telegram {
  static async send(text) {
    try {
      await fetch(`https://api.telegram.org/bot${CONFIG.telegram.botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: CONFIG.telegram.chatId,
          text,
          parse_mode: "HTML"
        })
      });
    } catch (e) {
      Logger.error("Telegram error: " + e.message);
    }
  }
}

/* ================= FACEBOOK ================= */

class FacebookAPI {
  static async createLive(token, name) {
    const res = await fetch("https://graph.facebook.com/v24.0/me/live_videos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: name,
        status: "UNPUBLISHED",
        access_token: token
      })
    });
    const json = await res.json();
    if (json.error) throw new Error(json.error.message);
    return json.id;
  }

  static async getStreamUrl(liveId, token) {
    const fields = "stream_url";
    for (let i = 0; i < 6; i++) {
      const r = await fetch(
        `https://graph.facebook.com/v24.0/${liveId}?fields=${fields}&access_token=${token}`
      );
      const j = await r.json();
      if (j.stream_url) return j.stream_url;
      await new Promise(r => setTimeout(r, 2000));
    }
    throw new Error("stream_url not ready");
  }
}

/* ================= STREAM MANAGER ================= */

class StreamManager {
  static async start(item) {
    const cached = streamUrlCache.get(item.id);
    if (!cached) throw new Error("No cached stream_url");

    Logger.success(`FFmpeg START → ${item.name}`);

    const cmd = ffmpeg(item.source)
      .inputOptions(["-re"])
      .outputOptions(["-c", "copy", "-f", "flv"])
      .output(cached.stream_url)
      .on("start", () => {
        Telegram.send(`✅ <b>LIVE</b>\n${item.name}`);
      })
      .on("error", err => {
        Logger.error(`${item.name} error: ${err.message}`);
        this.fail(item, err.message);
      })
      .on("end", () => {
        Logger.warn(`${item.name} ended`);
        this.fail(item, "Ended");
      });

    activeStreams.set(item.id, cmd);
    cmd.run();
  }

  static async fail(item, reason) {
    if (systemState !== "running") return;

    Logger.warn(`${item.name} stopped (${reason}), retry in 60s`);
    try {
      activeStreams.get(item.id)?.kill("SIGKILL");
    } catch {}
    activeStreams.delete(item.id);

    setTimeout(() => {
      if (systemState === "running") {
        this.start(item).catch(e =>
          Logger.error(`Retry failed ${item.name}: ${e.message}`)
        );
      }
    }, 120000);
  }

  static stopAll() {
    activeStreams.forEach(cmd => {
      try { cmd.kill("SIGKILL"); } catch {}
    });
    activeStreams.clear();
  }
}

/* ================= SYSTEM ================= */

class System {
  static async fetchStreams() {
    const r = await fetch(CONFIG.streamsApi);
    const j = await r.json();
    j.data.forEach((s, i) => {
      allItems.set(`item_${i}`, {
        id: `item_${i}`,
        name: s.name,
        token: s.token,
        source: s.source
      });
    });
  }

  static async start() {
    if (systemState === "running") return;
    systemState = "running";

    loadCache();
    await this.fetchStreams();

    for (const item of allItems.values()) {
      if (!streamUrlCache.has(item.id)) {
        Logger.info(`Creating LIVE for ${item.name}`);
        const liveId = await FacebookAPI.createLive(item.token, item.name);
        const url = await FacebookAPI.getStreamUrl(liveId, item.token);
        streamUrlCache.set(item.id, { liveId, stream_url: url });
        saveCache();
      }
      await StreamManager.start(item);
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  static async stop(reason = "Manual stop") {
    Logger.warn(`SYSTEM STOP (${reason})`);
    systemState = "stopped";
    StreamManager.stopAll();
    await Telegram.send(`⛔ <b>SYSTEM STOPPED</b>\n${reason}`);
  }
}

/* ================= BOOT ================= */

async function boot() {
  try {
    Logger.info("SYSTEM BOOTING...");
    await System.start();
  } catch (e) {
    Logger.error("BOOT FAILED: " + e.message);
    process.exit(1);
  }
}

boot();

/* keep node alive */
setInterval(() => {}, 1 << 30);

/* graceful shutdown */
process.on("SIGINT", async () => {
  Logger.warn("SIGINT");
  await System.stop("SIGINT");
  process.exit(0);
});

process.on("SIGTERM", async () => {
  Logger.warn("SIGTERM");
  await System.stop("SIGTERM");
  process.exit(0);
});
