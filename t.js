/******************************************************************
 * FACEBOOK MULTI STREAM MANAGER – CONTROL MODE
 * - START / STOP / RESTART via Control API
 * - No API data change checking
 * - Global restart every 3h45m
 * - Independent live retry (1 time)
 ******************************************************************/

import fs from "fs";
import ffmpeg from "fluent-ffmpeg";

// ================== CONFIG ==================
const CONFIG = {
  streamsApi: "https://ani-box-nine.vercel.app/api/grok-chat",

  //  CONTROL API (you will change this later)
  controlApi: "https://ovubovyckalyentrgahb.supabase.co/rest/v1/isState",
  controlToken: "sb_publishable_D1BH-HDP_S_myTuLK_q0gg_LbWZ0g5K"
  controlPollInterval: 20_000,
  healthCheckInterval: 30_000,
  reportInterval: 5 * 60_000,

  maxRetries: 1,
  restartDelay: 10_000,
  globalRestartAfter: 3.75 * 60 * 60 * 1000,

  telegram: {
    botToken: "7971806903:AAHwpdNzkk6ClL3O17JVxZnp5e9uI66L9WE",
    chatId: "-1002181683719",
  }
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
    // 🎥 VIDEO
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

    // 📦 BITRATE (CBR)
    "-b:v", "4500k",
    "-maxrate", "4500k",
    "-bufsize", "9000k",

    // 🔊 AUDIO
    "-c:a", "aac",
    "-b:a", "128k",
    "-ar", "44100",
    "-ac", "2",

    // 📡 FORMAT
    "-f", "flv",
    "-flvflags", "no_duration_filesize"
  ]
};


// ================== STATE ==================
let allItems = new Map();
let activeStreams = new Map();
let streamRetries = new Map();

let systemState = "stopped"; // running | stopped | restarting
let globalRestartTimer = null;
let startTime = Date.now();

// ================== LOGGER ==================
class Logger {
  static log(l, m) {
    const line = `[${new Date().toISOString()}] [${l}] ${m}`;
    console.log(line);
    fs.appendFileSync("system.log", line + "\n");
  }
  static info(m){this.log("INFO",m)}
  static warn(m){this.log("WARN",m)}
  static error(m){this.log("ERROR",m)}
  static success(m){this.log("SUCCESS",m)}
}

// ================== TELEGRAM ==================
class Telegram {
  static async send(text) {
    await fetch(
      `https://api.telegram.org/bot${CONFIG.telegram.botToken}/sendMessage`,
      {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({
          chat_id: CONFIG.telegram.chatId,
          text
        })
      }
    );
  }
}

// ================== FACEBOOK ==================
class FacebookAPI {
  static async createLive(token, name) {
    const res = await fetch(
      "https://graph.facebook.com/v24.0/me/live_videos",
      {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({
          title: name,
          status: "UNPUBLISHED",
          access_token: token
        })
      }
    );
    const j = await res.json();
    if (j.error) throw new Error(j.error.message);
    return { id: j.id, rtmps: j.secure_stream_url };
  }
}

// ================== STREAM MANAGER ==================
class StreamManager {
  static startFFmpeg(item) {
    Logger.info(`🎬 Starting ${item.name}`);
  
    const cmd = ffmpeg(item.source)
      .inputOptions(FACEBOOK_FFMPEG_OPTIONS.input)
      .outputOptions(FACEBOOK_FFMPEG_OPTIONS.output)
      .output(item.rtmps)
      .on("start", c => {
        Logger.success(`▶ ${item.name} started`);
        fs.appendFileSync(`ffmpeg_${item.id}.cmd.txt`, c + "\n");
      })
      .on("progress", () => {
        const i = activeStreams.get(item.id);
        if (i) i.lastOutput = Date.now();
      })
      .on("stderr", line => {
        fs.appendFileSync(
          `ffmpeg_${item.id}.log`,
          `[${new Date().toISOString()}] ${line}\n`
        );
      })
      .on("error", e => {
        Logger.error(`❌ ${item.name}: ${e.message}`);
        StreamManager.handleFailure(item, e.message);
      })
      .on("end", () => {
        Logger.warn(`⏹ ${item.name} ended`);
        StreamManager.handleFailure(item, "Stream ended");
      });
  
    activeStreams.set(item.id, {
      command: cmd,
      item,
      lastOutput: Date.now()
    });
  
    cmd.run();
    
  }

  static async handleFailure(item, reason) {
    const r = (streamRetries.get(item.id) || 0) + 1;
    streamRetries.set(item.id, r);

    if (r <= CONFIG.maxRetries && systemState === "running") {
      Logger.warn(`🔁 Retry ${item.name}`);
      await StreamManager.restartSingle(item);
      return;
    }

    Logger.error(`🛑 ${item.name} stopped permanently`);
    await Telegram.send(`❌ LIVE STOPPED\n${item.name}\n${reason}`);

    const info = activeStreams.get(item.id);
    try { info?.command.kill("SIGTERM"); } catch {}
    activeStreams.delete(item.id);
  }

  static async restartSingle(item) {
    const info = activeStreams.get(item.id);
    try { info?.command.kill("SIGTERM"); } catch {}
    activeStreams.delete(item.id);

    const live = await FacebookAPI.createLive(item.token, item.name);
    item.streamId = live.id;
    item.rtmps = live.rtmps;

    await new Promise(r=>setTimeout(r,3000));
    StreamManager.startFFmpeg(item);
  }

  static stopAll() {
    activeStreams.forEach(i=>{
      try { i.command.kill("SIGTERM"); } catch {}
    });
    activeStreams.clear();
    streamRetries.clear();
  }
}

// ================== MAIN SYSTEM ==================
class System {

  static async fetchStreams() {
    const r = await fetch(CONFIG.streamsApi);
    const j = await r.json();

    const map = new Map();
    j.data.forEach((it,i)=>{
      map.set(`item_${i}`, {
        id:`item_${i}`,
        token: it.token,
        name: it.name,
        source: it.source
      });
    });
    return map;
  }

  static async start() {
    if (systemState === "running") return;

    systemState = "running";
    startTime = Date.now();

    Logger.success("▶ SYSTEM START");
    await Telegram.send("▶ SYSTEM STARTED");

    allItems = await this.fetchStreams();

    for (const item of allItems.values()) {
      const live = await FacebookAPI.createLive(item.token, item.name);
      item.streamId = live.id;
      item.rtmps = live.rtmps;
      StreamManager.startFFmpeg(item);
      await new Promise(r=>setTimeout(r,2000));
    }

    if (globalRestartTimer) clearTimeout(globalRestartTimer);
    globalRestartTimer = setTimeout(()=>{
      System.restart("Scheduled 3h45m restart");
    }, CONFIG.globalRestartAfter);
  }

  static async stop(reason="Manual stop") {
    if (systemState === "stopped") return;

    Logger.warn("⛔ SYSTEM STOP");
    await Telegram.send(`⛔ SYSTEM STOPPED\n${reason}`);

    systemState = "stopped";
    StreamManager.stopAll();

    if (globalRestartTimer) clearTimeout(globalRestartTimer);
  }

  static async restart(reason) {
    Logger.warn("♻ SYSTEM RESTART");
    await Telegram.send(`♻ SYSTEM RESTART\n${reason}`);

    systemState = "restarting";
    StreamManager.stopAll();

    setTimeout(async ()=>{
      await System.start();
    }, CONFIG.restartDelay);
  }
}

// ================== CONTROL API POLLER ==================
setInterval(async ()=>{
  try {
    const r = await fetch(CONFIG.controlApi);
    const j = await r.json();

    if (j.action === "start") await System.start();
    if (j.action === "stop") await System.stop("Control API");
    if (j.action === "restart") await System.restart("Control API");

  } catch {}
}, CONFIG.controlPollInterval);

// ================== HEALTH CHECK ==================
setInterval(()=>{
  if (systemState !== "running") return;

  const now = Date.now();
  activeStreams.forEach(info=>{
    if (now - info.lastOutput > 60_000) {
      StreamManager.handleFailure(info.item, "No output 60s");
    }
  });
}, CONFIG.healthCheckInterval);

// ================== STATUS REPORT ==================
setInterval(async ()=>{
  if (systemState !== "running") return;

  const up = Math.floor((Date.now()-startTime)/60000);
  await Telegram.send(
    `📡 STATUS\nUptime: ${up} min\nActive: ${activeStreams.size}`
  );
}, CONFIG.reportInterval);

// ================== BOOT ==================
Logger.success("🟡 SYSTEM READY – WAITING FOR START");
