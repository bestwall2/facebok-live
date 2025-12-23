/******************************************************************
 * FACEBOOK MULTI STREAM MANAGER
 * Author: You
 * Description:
 * - Fetch streams from API
 * - Create Facebook Live
 * - Start FFmpeg
 * - Wait for ALL streams to be running
 * - Then fetch DASH URLs
 * - Send full Telegram reports
 * - Handle exceptions with delay
 ******************************************************************/

// ================== IMPORTS ==================
import { spawn } from "child_process";
import fs from "fs";

// ================== CONFIG ==================
const CONFIG = {
  apiUrl: "https://ani-box-nine.vercel.app/api/grok-chat",

  pollInterval: 60_000,          // فحص دوري كل دقيقة
  restartDelay: 1 * 60_000,      // ⏳ انتظار دقيقتين بعد أي استثناء
  reportInterval: 5 * 60_000,    // 📊 تقرير Telegram كل 5 دقائق

  telegram: {
    botToken: "7971806903:AAHwpdNzkk6ClL3O17JVxZnp5e9uI66L9WE",
    chatId: "5806630118",
  }
};

// ================== GLOBAL STATE ==================
let allItems = new Map();        // جميع البثوث
let activeStreams = new Map();  // FFmpeg processes
let isRestarting = false;
let startTime = Date.now();

// ================== LOGGER ==================
class Logger {
  static log(level, msg) {
    const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
    console.log(line);
    fs.appendFileSync("logs.txt", line + "\n");
  }
  static info(m) { this.log("INFO", m); }
  static warn(m) { this.log("WARN", m); }
  static error(m) { this.log("ERROR", m); }
  static success(m) { this.log("SUCCESS", m); }
}

// ================== TELEGRAM ==================
class Telegram {
  static async send(text) {
    const url = `https://api.telegram.org/bot${CONFIG.telegram.botToken}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CONFIG.telegram.chatId,
        text,
        parse_mode: "HTML"
      })
    });
  }
}

// ================== FACEBOOK ==================
class FacebookAPI {

  // إنشاء بث Facebook
  static async createLive(token, name) {
    const res = await fetch(
      "https://graph.facebook.com/v24.0/me/live_videos",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: name,
          status: "UNPUBLISHED",
          access_token: token
        })
      }
    );
    const json = await res.json();
    if (json.error) throw new Error(json.error.message);
    return {
      id: json.id,
      rtmps: json.secure_stream_url
    };
  }

  // جلب DASH بعد تشغيل FFmpeg
  static async getDash(id, token) {
    const res = await fetch(
      `https://graph.facebook.com/v24.0/${id}?fields=dash_preview_url&access_token=${token}`
    );
    const json = await res.json();
    return json.dash_preview_url;
  }
}

// ================== STREAM MANAGER ==================
class StreamManager {

  static startFFmpeg(item) {
    Logger.info(`Starting FFmpeg: ${item.name}`);

    const ff = spawn("ffmpeg", [
      "-re",
      "-i", item.source,
      "-c", "copy",
      "-f", "flv",
      item.rtmps
    ]);

    activeStreams.set(item.id, ff);

    ff.stderr.on("data", d => {
      const msg = d.toString();
      if (msg.includes("error")) {
        Logger.error(`FFmpeg error: ${item.name}`);
        ExceptionHandler.trigger("FFmpeg Error");
      }
    });

    ff.on("exit", code => {
      Logger.warn(`FFmpeg exited (${code})`);
      ExceptionHandler.trigger("FFmpeg Exit");
    });
  }

  static stopAll() {
    activeStreams.forEach(p => p.kill("SIGTERM"));
    activeStreams.clear();
  }
}

// ================== EXCEPTION HANDLER ==================
class ExceptionHandler {
  static async trigger(reason) {
    if (isRestarting) return;
    isRestarting = true;

    Logger.warn(`Exception: ${reason}`);
    await Telegram.send(`⚠️ Exception detected\n${reason}\n⏳ Restart in 2 minutes`);

    setTimeout(async () => {
      await Main.restart();
      isRestarting = false;
    }, CONFIG.restartDelay);
  }
}

// ================== MAIN ==================
class Main {

  // جلب البيانات من API
  static async fetchItems() {
    const res = await fetch(CONFIG.apiUrl);
    const json = await res.json();

    const map = new Map();
    json.data.forEach((it, i) => {
      map.set(`item_${i}`, {
        id: `item_${i}`,
        token: it.token,
        name: it.name,
        source: it.source,
        img: it.img
      });
    });
    return map;
  }

  // التشغيل الكامل
  static async start() {
    Logger.info("Fetching items...");
    allItems = await this.fetchItems();

    // 1️⃣ إنشاء بثوث Facebook
    for (const item of allItems.values()) {
      const live = await FacebookAPI.createLive(item.token, item.name);
      item.streamId = live.id;
      item.rtmps = live.rtmps;
    }

    // 2️⃣ تشغيل FFmpeg
    for (const item of allItems.values()) {
      StreamManager.startFFmpeg(item);
    }

    // 3️⃣ انتظار حتى يشتغل الجميع
    await new Promise(r => setTimeout(r, 8000));

    // 4️⃣ جلب DASH + إرسال تقرير
    let report = `📊 STREAM REPORT\n\n`;
    for (const item of allItems.values()) {
      item.dash = await FacebookAPI.getDash(item.streamId, item.token);
      report += `📺 ${item.name}\n${item.dash}\n\n`;
    }

    await Telegram.send(report);
    Logger.success("All streams running");
  }

  static async restart() {
    Logger.warn("Restarting system...");
    StreamManager.stopAll();
    await this.start();
  }
}

// ================== REPORT LOOP ==================
setInterval(async () => {
  const uptime = Math.floor((Date.now() - startTime) / 60000);
  await Telegram.send(`📡 Status OK\nUptime: ${uptime} minutes\nStreams: ${allItems.size}`);
}, CONFIG.reportInterval);

// ================== START ==================
Main.start().catch(e => {
  Logger.error(e.message);
  ExceptionHandler.trigger("Fatal Error");
});
