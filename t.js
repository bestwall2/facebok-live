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

  pollInterval: 60_000,          // Check every minute for API changes
  restartDelay: 2 * 60_000,      // ⏳ Wait 2 minutes after any exception
  reportInterval: 5 * 60_000,    // 📊 Telegram report every 5 minutes

  telegram: {
    botToken: "7971806903:AAHwpdNzkk6ClL3O17JVxZnp5e9uI66L9WE",
    chatId: "5806630118",
  }
};

// ================== GLOBAL STATE ==================
let allItems = new Map();        // All streams
let activeStreams = new Map();   // FFmpeg processes
let isRestarting = false;
let startTime = Date.now();
let apiDataHash = "";           // Store hash of API data to detect changes

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
  // Create Facebook Live
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

  // Get DASH after FFmpeg starts
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

// ================== API CHANGE DETECTOR ==================
class ApiChangeDetector {
  // Create a hash of API data to detect changes
  static createDataHash(data) {
    // Create a string from all items data
    const itemsString = data.map(item => 
      `${item.token}|${item.name}|${item.source}|${item.img}`
    ).sort().join('||');
    
    // Create hash from the string
    return Buffer.from(itemsString).toString('base64');
  }

  // Check if API data has changed
  static async checkForChanges() {
    try {
      Logger.info("Checking API for changes...");
      
      // Fetch fresh data from API
      const res = await fetch(CONFIG.apiUrl);
      const json = await res.json();
      
      // Create hash of new data
      const newHash = this.createDataHash(json.data);
      
      // If this is the first time, just store the hash
      if (apiDataHash === "") {
        apiDataHash = newHash;
        Logger.info("Initial API data hash stored");
        return false;
      }
      
      // Compare hashes
      if (newHash !== apiDataHash) {
        Logger.info(`API data changed! Old hash: ${apiDataHash.slice(0, 20)}..., New hash: ${newHash.slice(0, 20)}...`);
        
        // Send Telegram notification about the change
        const oldCount = allItems.size;
        const newCount = json.data.length;
        await Telegram.send(
          `🔄 API Changes Detected!\n\n` +
          `📊 Previous streams: ${oldCount}\n` +
          `📊 New streams: ${newCount}\n` +
          `⏳ Restarting in 2 minutes...`
        );
        
        // Update hash
        apiDataHash = newHash;
        
        // Trigger restart
        ExceptionHandler.trigger("API data changed");
        return true;
      }
      
      Logger.info("No changes in API data");
      return false;
      
    } catch (error) {
      Logger.error(`Error checking API changes: ${error.message}`);
      return false;
    }
  }
}

// ================== MAIN ==================
class Main {
  // Fetch data from API
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
    
    // Store initial hash
    if (apiDataHash === "") {
      apiDataHash = ApiChangeDetector.createDataHash(json.data);
    }
    
    return map;
  }

  // Full startup
  static async start() {
    Logger.info("Fetching items...");
    allItems = await this.fetchItems();

    // 1️⃣ Create Facebook Live streams
    for (const item of allItems.values()) {
      const live = await FacebookAPI.createLive(item.token, item.name);
      item.streamId = live.id;
      item.rtmps = live.rtmps;
    }

    // 2️⃣ Start FFmpeg
    for (const item of allItems.values()) {
      StreamManager.startFFmpeg(item);
    }

    // 3️⃣ Wait for all to start
    await new Promise(r => setTimeout(r, 8000));

    // 4️⃣ Get DASH + Send report
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

// ================== PERIODIC CHECKS ==================

// 📊 Status report every 5 minutes
setInterval(async () => {
  const uptime = Math.floor((Date.now() - startTime) / 60000);
  await Telegram.send(`📡 Status OK\nUptime: ${uptime} minutes\nStreams: ${allItems.size}`);
}, CONFIG.reportInterval);

// 🔍 API change check every minute
setInterval(async () => {
  if (!isRestarting) {
    await ApiChangeDetector.checkForChanges();
  } else {
    Logger.info("Skipping API check - system is restarting");
  }
}, CONFIG.pollInterval);

// ================== START ==================
Main.start().catch(e => {
  Logger.error(e.message);
  ExceptionHandler.trigger("Fatal Error");
});
