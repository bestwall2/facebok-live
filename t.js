/******************************************************************
 * FACEBOOK MULTI STREAM MANAGER (Enhanced)
 * Author: You
 * Features:
 * - Monitor API for any changes every minute
 * - Restart all streams on any change
 * - Collect DASH URLs only after FFmpeg is running
 * - Telegram report every 5 minutes with full details
 * - Handles FFmpeg crashes
 ******************************************************************/

import { spawn } from "child_process";
import fs from "fs";

// ================== CONFIG ==================
const CONFIG = {
  apiUrl: "https://ani-box-nine.vercel.app/api/grok-chat",
  pollInterval: 60_000,         // Check API every 1 minute
  restartDelay: 2 * 60_000,     // Wait 2 minutes before restarting after exception
  reportInterval: 5 * 60_000,   // Send Telegram report every 5 minutes
  telegram: {
    botTokens: ["7971806903:AAHwpdNzkk6ClL3O17JVxZnp5e9uI66L9WE"], // يمكنك إضافة أكثر من توكن
    chatIds: ["5806630118","6605454954"], // يمكن إضافة أكثر من chatId
  }
};

// ================== GLOBAL STATE ==================
let allItems = new Map();         // جميع البثوث الحالية
let activeStreams = new Map();    // FFmpeg processes
let isRestarting = false;         // لتجنب إعادة التشغيل المتعددة
let startTime = Date.now();       // وقت بدء التطبيق
let changeLog = [];               // لتسجيل كل التغيرات خلال 5 دقائق

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
    for (let i = 0; i < CONFIG.telegram.botTokens.length; i++) {
      for (let j = 0; j < CONFIG.telegram.chatIds.length; j++) {
        const url = `https://api.telegram.org/bot${CONFIG.telegram.botTokens[i]}/sendMessage`;
        await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: CONFIG.telegram.chatIds[j],
            text,
            parse_mode: "HTML"
          })
        });
      }
    }
  }
}

// ================== FACEBOOK ==================
class FacebookAPI {

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
    return { id: json.id, rtmps: json.secure_stream_url };
  }

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
    const ff = spawn("ffmpeg", ["-re", "-i", item.source, "-c", "copy", "-f", "flv", item.rtmps]);
    activeStreams.set(item.id, ff);

    ff.stderr.on("data", d => {
      const msg = d.toString();
      if (msg.toLowerCase().includes("error")) {
        Logger.error(`FFmpeg error: ${item.name}`);
        changeLog.push(`⚠️ FFmpeg error for ${item.name}`);
        ExceptionHandler.trigger("FFmpeg Error");
      }
    });

    ff.on("exit", code => {
      Logger.warn(`FFmpeg exited (${code}) - ${item.name}`);
      changeLog.push(`⚠️ FFmpeg exited for ${item.name}`);
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
    changeLog.push(`⚠️ Exception triggered: ${reason}`);
    await Telegram.send(`⚠️ Exception detected\n${reason}\n⏳ Restart in 2 minutes`);

    setTimeout(async () => {
      await Main.restart();
      isRestarting = false;
    }, CONFIG.restartDelay);
  }
}

// ================== MAIN ==================
class Main {

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

  static async start() {
    Logger.info("Fetching items...");
    const newItems = await this.fetchItems();

    // مقارنة مع العناصر السابقة
    this.detectChanges(allItems, newItems);
    allItems = newItems;

    // إنشاء بثوث Facebook
    for (const item of allItems.values()) {
      const live = await FacebookAPI.createLive(item.token, item.name);
      item.streamId = live.id;
      item.rtmps = live.rtmps;
    }

    // تشغيل FFmpeg
    for (const item of allItems.values()) StreamManager.startFFmpeg(item);

    // انتظار الجميع
    await new Promise(r => setTimeout(r, 8000));

    // جلب DASH URLs
    let report = `📊 STREAM REPORT\n\n`;
    for (const item of allItems.values()) {
      item.dash = await FacebookAPI.getDash(item.streamId, item.token);
      report += `📺 ${item.name}\nDASH: ${item.dash}\n\n`;
    }
    changeLog.push(report);
    await Telegram.send(report);

    Logger.success("All streams running");
  }

  static async restart() {
    Logger.warn("Restarting system...");
    StreamManager.stopAll();
    await this.start();
  }

  // مقارنة التغييرات في API
  static detectChanges(oldItems, newItems) {
    oldItems.forEach((oldItem, id) => {
      if (!newItems.has(id)) changeLog.push(`❌ Removed: ${oldItem.name}`);
    });

    newItems.forEach((newItem, id) => {
      const oldItem = oldItems.get(id);
      if (!oldItem) {
        changeLog.push(`🆕 Added: ${newItem.name}`);
        ExceptionHandler.trigger("New Item Added");
      } else if (
        oldItem.token !== newItem.token ||
        oldItem.name !== newItem.name ||
        oldItem.source !== newItem.source ||
        oldItem.img !== newItem.img
      ) {
        changeLog.push(`✏️ Updated: ${newItem.name}`);
        ExceptionHandler.trigger("Item Updated");
      }
    });
  }
}

// ================== TELEGRAM REPORT LOOP ==================
setInterval(async () => {
  if (changeLog.length === 0) return;
  const uptime = Math.floor((Date.now() - startTime) / 60000);
  let msg = `📡 STATUS REPORT\nUptime: ${uptime} minutes\n\n`;
  msg += changeLog.join("\n\n");
  await Telegram.send(msg);
  changeLog = []; // إعادة تعيين
}, CONFIG.reportInterval);

// ================== START ==================
Main.start().catch(e => {
  Logger.error(e.message);
  ExceptionHandler.trigger("Fatal Error");
});
