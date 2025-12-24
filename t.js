/******************************************************************
 * FACEBOOK MULTI STREAM MANAGER – ADVANCED
 * - dynamic list watcher
 * - cache stream_url
 * - auto add/remove streams
 * - final dash report
 * - Telegram bot commands
 * - 1:50 minute initial delay for ALL servers
 * - 30 second delay for NEW servers
 * - 2 minute delay for CRASHED servers
 * - 3:45 hour stream key rotation (NO quality checks)
 * - Server shutdown reports
 ******************************************************************/

import fs from "fs";
import ffmpeg from "fluent-ffmpeg";
import fetch from "node-fetch";
import os from "os";
import process from "process";

/* ================= CONFIG ================= */

const CONFIG = {
  streamsApi: "https://ani-box-nine.vercel.app/api/grok-chat",
  pollInterval: 20000,
  telegram: {
    botToken: "7971806903:AAHwpdNzkk6ClL3O17JVxZnp5e9uI66L9WE",
    chatId: "-1002181683719",
  },
  initialDelay: 1000, // 1:50 minutes for ALL servers initial start
  newServerDelay: 30000, // 30 seconds for NEW servers
  crashedServerDelay: 120000, // 2 minutes (120 seconds) for CRASHED servers
  rotationInterval: 13500000, // 3:45 hours in milliseconds (3*60*60*1000 + 45*60*1000)
};

const CACHE_FILE = "./streams_cache.json";

/* ================= STATE ================= */

let systemState = "running";
let apiItems = new Map(); // current api list
let activeStreams = new Map(); // ffmpeg processes
let streamCache = new Map(); // stream_url cache
let streamStartTimes = new Map(); // track stream start times
let streamRotationTimers = new Map(); // rotation timers
let restartTimers = new Map(); // restart timers
let serverStates = new Map(); // server states: 'starting', 'running', 'restarting', 'rotating'
let startupTimer = null; // for initial startup delay

/* ================= CACHE ================= */

function loadCache() {
  if (!fs.existsSync(CACHE_FILE)) return;
  try {
    const json = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    Object.entries(json).forEach(([k, v]) => streamCache.set(k, v));
    log(`✅ Loaded ${streamCache.size} cached streams`);
  } catch (error) {
    log(`❌ Error loading cache: ${error.message}`);
  }
}

function saveCache() {
  try {
    const o = {};
    streamCache.forEach((v, k) => (o[k] = v));
    fs.writeFileSync(CACHE_FILE, JSON.stringify(o, null, 2));
  } catch (error) {
    log(`❌ Error saving cache: ${error.message}`);
  }
}

/* ================= LOGGER ================= */

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

/* ================= TELEGRAM ================= */

async function tg(msg, chatId = CONFIG.telegram.chatId) {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${CONFIG.telegram.botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: msg,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      }
    );

    const result = await response.json();
    if (!result.ok) {
      log(`❌ Telegram error: ${result.description}`);
    }
  } catch (error) {
    log(`❌ Telegram send error: ${error.message}`);
  }
}

/* ================= FACEBOOK ================= */

async function createLive(token, name) {
  log(`🌐 Creating Facebook Live for: ${name}`);

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
  if (j.error) {
    log(`❌ Facebook API error: ${j.error.message}`);
    throw new Error(j.error.message);
  }
  log(`✅ Created Live ID: ${j.id}`);
  return j.id;
}

async function getStreamAndDash(liveId, token) {
  log(`🌐 Getting stream URL for Live ID: ${liveId}`);
  const fields = "stream_url,dash_preview_url,status";
  for (let i = 0; i < 6; i++) {
    const r = await fetch(
      `https://graph.facebook.com/v24.0/${liveId}?fields=${fields}&access_token=${token}`
    );
    const j = await r.json();
    if (j.stream_url) {
      log(`✅ Stream URL ready for ${liveId}`);
      return {
        stream_url: j.stream_url,
        dash: j.dash_preview_url || "N/A",
        status: j.status || "UNKNOWN",
      };
    }
    log(`⏳ Waiting for stream URL (attempt ${i + 1}/6)...`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("Preview not ready");
}

/* ================= FFMPEG ================= */

function startFFmpeg(item, force = false) {
  const cache = streamCache.get(item.id);
  if (!cache) {
    log(`❌ No cache for ${item.name}, cannot start`);
    return;
  }

  // Check if already starting or restarting
  const state = serverStates.get(item.id);
  if (!force && (state === "starting" || state === "restarting")) {
    log(`⚠️ ${item.name} is already starting/restarting, skipping`);
    return;
  }

  log(`▶ STARTING ${item.name}`);
  serverStates.set(item.id, "starting");

  // Clear any existing restart timer
  if (restartTimers.has(item.id)) {
    clearTimeout(restartTimers.get(item.id));
    restartTimers.delete(item.id);
  }

  const cmd = ffmpeg(item.source)
    .inputOptions([
      "-re",
      "-hide_banner",
      "-loglevel",
      "error",
      "-reconnect",
      "1",
      "-reconnect_at_eof",
      "1",
      "-reconnect_streamed",
      "1",
      "-reconnect_delay_max",
      "5",
      "-fflags",
      "+genpts+igndts",
    ])
    .videoCodec("libx264")
    .audioCodec("aac")
    .audioChannels(1)
    .audioFrequency(44100)
    .audioBitrate("96k")
    .outputOptions([
      "-preset",
      "veryfast",
      "-tune",
      "zerolatency",
      "-b:v",
      "2500k",
      "-maxrate",
      "2500k",
      "-bufsize",
      "5000k",
      "-g",
      "60",
      "-r",
      "30",
      "-pix_fmt",
      "yuv420p",
      "-f",
      "flv",
      "-flvflags",
      "no_duration_filesize",
      "-rtmp_live",
      "live",
    ])
    .output(cache.stream_url)
    .on("start", (commandLine) => {
      log(`✅ FFmpeg started for ${item.name}`);
      streamStartTimes.set(item.id, Date.now());
      serverStates.set(item.id, "running");

      // Start rotation timer (3:45 hours)
      startRotationTimer(item);
    })
    .on("error", (err) => {
      log(`❌ FFmpeg error for ${item.name}: ${err.message}`);
      handleStreamCrash(item, err.message);
    })
    .on("end", () => {
      log(`🔚 FFmpeg ended for ${item.name}`);
      handleStreamCrash(item, "Stream ended unexpectedly");
    });

  activeStreams.set(item.id, cmd);
  cmd.run();
}


function handleStreamCrash(item, reason) {
  const state = serverStates.get(item.id);

  // Don't send report if we're rotating or intentionally stopping
  if (state === "rotating") {
    log(
      `🔄 ${item.name} crashed during rotation, will continue rotation process`
    );
    return;
  }

  // Send crash report
  const uptime = streamStartTimes.has(item.id)
    ? formatUptime(Date.now() - streamStartTimes.get(item.id))
    : "Unknown";

  tg(
    `🔴 <b>SERVER CRASH REPORT</b>\n\n` +
      `<b>${item.name}</b>\n` +
      `Reason: ${reason}\n` +
      `Uptime: ${uptime}\n` +
      `Status: Will restart in 2 minutes`
  );

  log(`🔄 ${item.name} will restart in 2 minutes`);

  // Schedule restart in 2 MINUTES (120 seconds) for crashed servers
  serverStates.set(item.id, "restarting");
  stopFFmpeg(item.id);

  const restartTimer = setTimeout(() => {
    if (
      systemState === "running" &&
      serverStates.get(item.id) === "restarting"
    ) {
      log(`▶ Attempting restart ${item.name}`);
      startFFmpeg(item);
    }
  }, CONFIG.crashedServerDelay); // 2 MINUTES for crashed servers

  restartTimers.set(item.id, restartTimer);
}

function stopFFmpeg(id, skipReport = false) {
  try {
    const proc = activeStreams.get(id);
    if (proc) {
      proc.kill("SIGTERM"); // Use SIGTERM first for graceful shutdown
      setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {} // Force kill if not terminated
      }, 5000);

      if (!skipReport) {
        const state = serverStates.get(id);
        if (state === "running") {
          const item = apiItems.get(id);
          if (item) {
            const uptime = streamStartTimes.has(id)
              ? formatUptime(Date.now() - streamStartTimes.get(id))
              : "Unknown";
            log(`⏹️ Stopped ${item.name} (was running for ${uptime})`);
          }
        }
      }
    }
  } catch (err) {
    log(`❌ Error stopping ${id}: ${err.message}`);
  }

  activeStreams.delete(id);
  streamStartTimes.delete(id);
}

/* ================= ROTATION SYSTEM ================= */

function startRotationTimer(item) {
  // Clear existing rotation timer
  if (streamRotationTimers.has(item.id)) {
    clearTimeout(streamRotationTimers.get(item.id));
  }

  log(`⏰ Rotation timer started for ${item.name} (3:45 hours)`);

  const rotationTimer = setTimeout(async () => {
    log(`🔄 Rotating stream key for ${item.name} (3:45 hours elapsed)`);
    await rotateStreamKey(item);
  }, CONFIG.rotationInterval);

  streamRotationTimers.set(item.id, rotationTimer);
}

async function rotateStreamKey(item) {
  try {
    log(`🔄 Starting key rotation for ${item.name}`);
    serverStates.set(item.id, "rotating");

    // Stop current stream gracefully
    stopFFmpeg(item.id, true);

    // Remove old cache
    streamCache.delete(item.id);
    saveCache();

    // Create new live stream
    log(`🌐 Creating new live stream for ${item.name}`);
    const liveId = await createLive(item.token, item.name);
    const preview = await getStreamAndDash(liveId, item.token);

    // Update cache with new stream
    streamCache.set(item.id, { liveId, ...preview });
    saveCache();

    // Send rotation report
    await tg(
      `🔄 <b>STREAM KEY ROTATED</b>\n\n` +
        `<b>${item.name}</b>\n` +
        `Old key: Removed\n` +
        `New key: Generated\n` +
        `DASH URL: <code>${preview.dash}</code>\n` +
        `Status: Will start in 30 seconds`
    );

    // Start with new key after 30 seconds (NEW server delay)
    log(`⏰ ${item.name} will start with new key in 30 seconds`);
    serverStates.set(item.id, "starting");

    // ✅ NEW - correct
    setTimeout(() => {
      if (systemState === "running") {
        startFFmpeg(item);
      }
    }, CONFIG.newServerDelay); // 30 SECONDS for rotation (treated as new server)
  } catch (error) {
    log(`❌ Rotation failed for ${item.name}: ${error.message}`);
    serverStates.set(item.id, "failed");

    // Try again in 5 minutes
    setTimeout(() => {
      if (systemState === "running") {
        log(`🔄 Retrying rotation for ${item.name}`);
        rotateStreamKey(item);
      }
    }, 300000);
  }
}

/* ================= UPTIME CALCULATION ================= */

function formatUptime(uptimeMs) {
  if (!uptimeMs || uptimeMs < 0) return "Not active";

  const seconds = Math.floor((uptimeMs / 1000) % 60);
  const minutes = Math.floor((uptimeMs / (1000 * 60)) % 60);
  const hours = Math.floor((uptimeMs / (1000 * 60 * 60)) % 24);
  const days = Math.floor(uptimeMs / (1000 * 60 * 60 * 24));

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);

  return parts.join(" ");
}

/* ================= SERVER INFO ================= */

function getServerInfo() {
  const serverInfo = {
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    uptime: formatUptime(process.uptime() * 1000),
    memory: {
      used: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`,
      total: `${Math.round(os.totalmem() / 1024 / 1024)}MB`,
    },
    streams: {
      active: activeStreams.size,
      total: apiItems.size,
      cached: streamCache.size,
    },
    time: new Date().toLocaleString(),
    initialDelay: `${CONFIG.initialDelay / 1000} seconds`,
    newServerDelay: `${CONFIG.newServerDelay / 1000} seconds`,
    crashedServerDelay: `${
      CONFIG.crashedServerDelay / 1000
    } seconds (2 minutes)`,
    rotationInterval: `${CONFIG.rotationInterval / (1000 * 60 * 60)} hours`,
  };

  return serverInfo;
}

/* ================= INFO REPORT ================= */

async function generateInfoReport() {
  const serverInfo = getServerInfo();
  const now = new Date();

  let report = `📊 <b>SYSTEM STATUS REPORT</b>\n`;
  report += `⏰ <i>${now.toLocaleString()}</i>\n\n`;

  report += `🖥️ <b>Server Info:</b>\n`;
  report += `• Host: ${serverInfo.hostname}\n`;
  report += `• Platform: ${serverInfo.platform} (${serverInfo.arch})\n`;
  report += `• Node.js: ${serverInfo.nodeVersion}\n`;
  report += `• Server Uptime: ${serverInfo.uptime}\n`;
  report += `• Memory: ${serverInfo.memory.used} / ${serverInfo.memory.total}\n`;
  report += `• Initial Delay: ${serverInfo.initialDelay}\n`;
  report += `• New Server Delay: ${serverInfo.newServerDelay}\n`;
  report += `• Crashed Server Delay: ${serverInfo.crashedServerDelay}\n`;
  report += `• Rotation: ${serverInfo.rotationInterval}\n\n`;

  report += `📡 <b>Stream Stats:</b>\n`;
  report += `• Active: ${serverInfo.streams.active}\n`;
  report += `• Total: ${serverInfo.streams.total}\n`;
  report += `• Cached: ${serverInfo.streams.cached}\n\n`;

  report += `🎬 <b>Stream Status:</b>\n`;

  let streamCount = 0;
  for (const [id, cache] of streamCache) {
    if (streamCount >= 5) {
      report += `\n... and ${streamCache.size - 5} more streams`;
      break;
    }

    const item = apiItems.get(id);
    const startTime = streamStartTimes.get(id);
    const state = serverStates.get(id);
    const isActive = activeStreams.has(id);

    if (item) {
      report += `\n<b>${item.name}</b>\n`;
      report += `• Status: ${state || "unknown"}\n`;
      report += `• Active: ${isActive ? "🟢" : "🔴"}\n`;
      report += `• Uptime: ${formatUptime(
        startTime ? Date.now() - startTime : 0
      )}\n`;
      report += `• DASH: <code>${cache.dash}</code>\n`;

      streamCount++;
    }
  }

  if (streamCount === 0) {
    report += `\nNo streams configured.\n`;
  }

  report += `\n🔄 <i>Last checked: ${now.toLocaleTimeString()}</i>`;

  return report;
}

/* ================= API WATCHER ================= */

async function fetchApiList() {
  try {
    const r = await fetch(CONFIG.streamsApi);
    const j = await r.json();
    const map = new Map();
    j.data.forEach((s, i) => {
      map.set(`item_${i}`, {
        id: `item_${i}`,
        name: s.name,
        token: s.token,
        source: s.source,
      });
    });
    return map;
  } catch (error) {
    log(`❌ Error fetching API list: ${error.message}`);
    return apiItems; // Return current list on error
  }
}

async function watcher() {
  try {
    const newList = await fetchApiList();

    /* ➕ NEW ITEMS */
    for (const [id, item] of newList) {
      if (!apiItems.has(id)) {
        log(`➕ NEW SERVER DETECTED ${item.name}`);
        try {
          const liveId = await createLive(item.token, item.name);
          const preview = await getStreamAndDash(liveId, item.token);
          streamCache.set(id, { liveId, ...preview });
          saveCache();

          // Wait 30 SECONDS before starting NEW servers
          log(`⏰ New server ${item.name} will start in 30 seconds`);
          setTimeout(() => {
            if (systemState === "running") {
              log(`▶ Starting NEW server: ${item.name}`);
              startFFmpeg(item);
            }
          }, CONFIG.newServerDelay);
 // 30 SECONDS for NEW servers
        } catch (error) {
          log(`❌ Error creating live for ${item.name}: ${error.message}`);
        }
      }
    }

    /* ❌ REMOVED ITEMS */
    for (const [id] of apiItems) {
      if (!newList.has(id)) {
        log(`❌ REMOVED ITEM ${id}`);

        // Clear all timers
        if (restartTimers.has(id)) {
          clearTimeout(restartTimers.get(id));
          restartTimers.delete(id);
        }
        if (streamRotationTimers.has(id)) {
          clearTimeout(streamRotationTimers.get(id));
          streamRotationTimers.delete(id);
        }

        stopFFmpeg(id, true);
        streamCache.delete(id);
        streamStartTimes.delete(id);
        serverStates.delete(id);
        saveCache();
      }
    }

    apiItems = newList;
  } catch (error) {
    log(`❌ Watcher error: ${error.message}`);
  }
}

/* ================= TELEGRAM BOT COMMANDS ================= */

let lastCommandTime = new Map();

async function handleTelegramCommand(update) {
  try {
    const message = update.message;
    if (!message || !message.text) return;

    const chatId = message.chat.id;
    const userId = message.from.id;
    const command = message.text.trim();
    const now = Date.now();

    // Rate limiting: 1 command per 5 seconds per user
    if (lastCommandTime.has(userId)) {
      const lastTime = lastCommandTime.get(userId);
      if (now - lastTime < 5000) {
        await tg("⏳ Please wait 5 seconds between commands.", chatId);
        return;
      }
    }
    lastCommandTime.set(userId, now);

    // Clean old entries
    if (lastCommandTime.size > 100) {
      const oldest = Array.from(lastCommandTime.entries())
        .sort((a, b) => a[1] - b[1])
        .slice(0, 20);
      oldest.forEach(([uid]) => lastCommandTime.delete(uid));
    }

    // Handle /info command
    if (command === "/info" || command.startsWith("/info")) {
      const report = await generateInfoReport();
      await tg(report, chatId);
      return;
    }

    // Handle /status command (short version)
    if (command === "/status" || command.startsWith("/status")) {
      const status =
        `📊 <b>Stream Manager Status</b>\n\n` +
        `🟢 Active Streams: ${activeStreams.size}\n` +
        `📋 Total Items: ${apiItems.size}\n` +
        `⏰ Server Uptime: ${formatUptime(process.uptime() * 1000)}\n` +
        `🆕 New Server Delay: ${CONFIG.newServerDelay / 1000}s\n` +
        `🔧 Crashed Server Delay: ${CONFIG.crashedServerDelay / 1000}s\n` +
        `⏳ Rotation: ${CONFIG.rotationInterval / (1000 * 60 * 60)}h\n` +
        `🕒 Time: ${new Date().toLocaleString()}\n\n` +
        `Use /info for detailed report`;
      await tg(status, chatId);
      return;
    }

    // Handle /help command
    if (command === "/help" || command.startsWith("/help")) {
      const helpText =
        `🤖 <b>Stream Manager Bot Commands</b>\n\n` +
        `/info - Get detailed system and stream report\n` +
        `/status - Quick status check\n` +
        `/help - Show this help message\n\n` +
        `<i>Auto-monitoring ${CONFIG.pollInterval / 1000}s intervals</i>\n` +
        `<i>New server delay: ${CONFIG.newServerDelay / 1000}s</i>\n` +
        `<i>Crashed server delay: ${CONFIG.crashedServerDelay / 1000}s</i>\n` +
        `<i>Rotation interval: ${
          CONFIG.rotationInterval / (1000 * 60 * 60)
        }h</i>`;
      await tg(helpText, chatId);
    }
  } catch (error) {
    console.error("Command handler error:", error);
  }
}

// Poll Telegram for updates
async function telegramBotPolling() {
  let offset = 0;

  while (systemState === "running") {
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${CONFIG.telegram.botToken}/getUpdates?offset=${offset}&timeout=30`
      );

      const data = await response.json();

      if (data.ok && data.result.length > 0) {
        for (const update of data.result) {
          offset = update.update_id + 1;
          await handleTelegramCommand(update);
        }
      }
    } catch (error) {
      console.error("Telegram polling error:", error);
      await new Promise((r) => setTimeout(r, 5000));
    }

    await new Promise((r) => setTimeout(r, 1000));
  }
}

/* ================= FINAL CHECK ================= */

async function finalCheckReport() {
  if (activeStreams.size === 0) {
    await tg(
      "⚠️ <b>No active streams detected</b>\nSystem is running but no streams are active."
    );
    return;
  }

  const lines = [];
  streamCache.forEach((v, id) => {
    const item = apiItems.get(id);
    const startTime = streamStartTimes.get(id);
    const state = serverStates.get(id);
    lines.push(
      `<b>${item ? item.name : id}</b>\n` +
        `Status: ${state || "unknown"}\n` +
        `DASH: <code>${v.dash}</code>\n` +
        `Uptime: ${formatUptime(startTime ? Date.now() - startTime : 0)}`
    );
  });

  await tg(`📡 <b>DASH REPORT</b>\n\n${lines.join("\n\n")}`);
}

/* ================= BOOT ================= */

async function boot() {
  log("🚀 Booting Stream Manager...");

  try {
    loadCache();
    apiItems = await fetchApiList();

    log(`📋 Loaded ${apiItems.size} items from API`);
    log(`💾 Loaded ${streamCache.size} cached streams`);

    // Send startup notification
    const delaySeconds = CONFIG.initialDelay / 1000;
    await tg(
      `🚀 <b>Stream Manager Started</b>\n\n` +
        `Total items: ${apiItems.size}\n` +
        `Cached streams: ${streamCache.size}\n` +
        `⏳ All streams will start in ${delaySeconds} seconds\n` +
        `🆕 New server delay: ${CONFIG.newServerDelay / 1000}s\n` +
        `🔧 Crashed server delay: ${CONFIG.crashedServerDelay / 1000}s\n` +
        `🔄 Auto-rotation: ${
          CONFIG.rotationInterval / (1000 * 60 * 60)
        } hours\n` +
        `Bot commands: /info /status /help`
    );

    // Create Facebook Live for any missing items
    for (const item of apiItems.values()) {
      if (!streamCache.has(item.id)) {
        log(`🆕 Creating new live for ${item.name}`);
        try {
          const liveId = await createLive(item.token, item.name);
          const preview = await getStreamAndDash(liveId, item.token);
          streamCache.set(item.id, { liveId, ...preview });
          saveCache();
        } catch (error) {
          log(`❌ Failed to create live for ${item.name}: ${error.message}`);
        }
      }
    }

    // ⭐ Wait 1:50 minutes before starting ALL servers
    log(`⏳ Waiting ${delaySeconds} seconds before starting all servers...`);

    startupTimer = setTimeout(() => {
      log(`▶ Starting ALL servers after ${delaySeconds} second delay`);

      // Start all servers after the delay
      for (const item of apiItems.values()) {
        startFFmpeg(item);
      }

      log(`✅ Started ${apiItems.size} servers`);

      // Start watcher after servers are running
      setInterval(watcher, CONFIG.pollInterval);
      log(`🔍 Watcher started with ${CONFIG.pollInterval / 1000}s intervals`);

      // Send final report
      setTimeout(finalCheckReport, 300000); // 5 minutes after servers start
      log(`📊 Final report scheduled in 5 minutes`);
    }, CONFIG.initialDelay);

    // Start Telegram bot polling immediately
    telegramBotPolling();
    log(`🤖 Telegram bot polling started`);
  } catch (error) {
    log(`❌ Boot failed: ${error.message}`);
    await tg(`❌ <b>Stream Manager Boot Failed</b>\n${error.message}`);
    process.exit(1);
  }
}

boot();

/* ================= SHUTDOWN ================= */

async function gracefulShutdown() {
  systemState = "stopping";
  log("🛑 Shutting down gracefully...");

  // Clear the startup timer if it exists
  if (startupTimer) {
    clearTimeout(startupTimer);
  }

  await tg(
    "🛑 <b>Stream Manager Shutting Down</b>\n" +
      `Stopping ${activeStreams.size} active streams\n` +
      `Cleaning up all timers`
  );

  // Clear all timers
  restartTimers.forEach((timer, id) => {
    clearTimeout(timer);
  });
  streamRotationTimers.forEach((timer, id) => {
    clearTimeout(timer);
  });

  // Stop all streams
  for (const [id] of activeStreams) {
    stopFFmpeg(id, true);
  }

  // Wait a bit for processes to terminate
  await new Promise((r) => setTimeout(r, 2000));

  log("👋 Shutdown complete");
  process.exit(0);
}

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);
