// ================== IMPORTS ==================
import { spawn } from "child_process";
import { writeFileSync, appendFileSync } from "fs";

// ================== CONFIG ==================
const CONFIG = {
  apiUrl: "https://ani-box-nine.vercel.app/api/grok-chat",
  pollInterval: 60000,
  restartDelay: 3000,

  telegram: {
    botToken: "7971806903:AAHwpdNzkk6ClL3O17JVxZnp5e9uI66L9WE",
    chatId: "5806630118",
    reportInterval: 5 * 60 * 1000,
  },
};

// ================== GLOBAL STATE ==================
let allItems = new Map();
let activeStreams = new Map();
let isRestarting = false;

const STATS = {
  startTime: Date.now(),
  restarts: 0,
  errors: 0,
};

// ================== LOGGER ==================
class Logger {
  static log(level, msg, id = "") {
    const line = `[${new Date().toISOString()}] [${level}] ${id} ${msg}`;
    console.log(line);
    appendFileSync("app.log", line + "\n");
    if (level === "ERROR") STATS.errors++;
  }
  static info(m, i) { this.log("INFO", m, i); }
  static warn(m, i) { this.log("WARN", m, i); }
  static error(m, i) { this.log("ERROR", m, i); }
  static success(m, i) { this.log("SUCCESS", m, i); }
}

// ================== TELEGRAM ==================
class Telegram {
  static async send(text) {
    try {
      await fetch(
        `https://api.telegram.org/bot${CONFIG.telegram.botToken}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: CONFIG.telegram.chatId,
            text,
            parse_mode: "HTML",
          }),
        }
      );
    } catch {}
  }

  static async sendEvent(title, body) {
    await this.send(
`🚨 <b>${title}</b>

${body}

⏱ ${new Date().toLocaleString()}`
    );
  }

  static async sendFullReport() {
    const uptime = Math.floor((Date.now() - STATS.startTime) / 60000);
    const running = [...activeStreams.values()].filter(s => s.running);

    let msg = `
📊 <b>STREAM STATUS REPORT</b>

⏱ Uptime: ${uptime} min
📡 Streams: ${running.length}/${allItems.size}
🔁 Restarts: ${STATS.restarts}
❌ Errors: ${STATS.errors}

📺 <b>Live Streams:</b>
`;

    running.forEach(s => {
      msg += `• ${s.name}\n`;
    });

    msg += `\n📦 DASH URLs:\n`;
    running.forEach(s => {
      if (s.dashUrl) msg += `• ${s.name}\n${s.dashUrl}\n\n`;
    });

    await this.send(msg);
  }
}

// ================== FACEBOOK API ==================
class FacebookAPI {
  static async createLive(token, name) {
    const r = await fetch("https://graph.facebook.com/v24.0/me/live_videos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: name,
        status: "UNPUBLISHED",
        access_token: token,
      }),
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    return { id: j.id, rtmps: j.secure_stream_url };
  }

  static async getDash(id, token) {
    const r = await fetch(
      `https://graph.facebook.com/v24.0/${id}?fields=dash_preview_url&access_token=${token}`
    );
    const j = await r.json();
    return j.dash_preview_url || null;
  }
}

// ================== STREAM MANAGER ==================
class StreamManager {
  static start(item) {
    Logger.info("Starting FFmpeg", item.id);

    const ff = spawn("ffmpeg", [
      "-re",
      "-i", item.source,
      "-c", "copy",
      "-f", "flv",
      item.rtmps,
    ]);

    activeStreams.set(item.id, {
      ...item,
      process: ff,
      running: true,
      dashUrl: null,
    });

    ff.stderr.on("data", d => {
      if (d.toString().includes("error")) {
        Logger.error("FFmpeg error", item.id);
        this.handleCrash(item.id);
      }
    });

    ff.on("close", () => {
      Logger.warn("FFmpeg stopped", item.id);
      this.handleCrash(item.id);
    });
  }

  static handleCrash(id) {
    if (!isRestarting) {
      Telegram.sendEvent("Stream Crashed", `Stream ID: ${id}`);
      Main.restart();
    }
  }

  static allRunning() {
    return [...activeStreams.values()].every(s => s.running);
  }
}

// ================== MAIN ==================
class Main {
  static async fetchItems() {
    const r = await fetch(CONFIG.apiUrl);
    const j = await r.json();
    const map = new Map();

    j.data.forEach((it, i) => {
      map.set(it.name + i, {
        id: it.name + i,
        token: it.token,
        name: it.name,
        source: it.source,
        img: it.img,
      });
    });

    return map;
  }

  static async startAll() {
    allItems = await this.fetchItems();
    activeStreams.clear();

    for (const item of allItems.values()) {
      const live = await FacebookAPI.createLive(item.token, item.name);
      item.streamId = live.id;
      item.rtmps = live.rtmps;
      StreamManager.start(item);
    }

    // ⏳ انتظر حتى تعمل كل FFmpeg
    while (!StreamManager.allRunning()) {
      await new Promise(r => setTimeout(r, 2000));
    }

    // 🔥 الآن فقط استخرج DASH
    for (const s of activeStreams.values()) {
      s.dashUrl = await FacebookAPI.getDash(s.streamId, s.token);
    }

    await Telegram.sendFullReport();
  }

  static async restart() {
    isRestarting = true;
    STATS.restarts++;
    Telegram.sendEvent("System Restart", "Restarting all streams...");
    activeStreams.forEach(s => s.process.kill("SIGTERM"));
    await new Promise(r => setTimeout(r, CONFIG.restartDelay));
    await this.startAll();
    isRestarting = false;
  }
}

// ================== START ==================
(async () => {
  writeFileSync("app.log", "=== START ===\n");
  await Main.startAll();

  setInterval(async () => {
    const newItems = await Main.fetchItems();
    if (newItems.size !== allItems.size) {
      Telegram.sendEvent("Stream List Changed", "Restarting...");
      Main.restart();
    }
  }, CONFIG.pollInterval);

  setInterval(() => Telegram.sendFullReport(), CONFIG.telegram.reportInterval);
})();
