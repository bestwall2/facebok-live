/******************************************************************
 * FACEBOOK MULTI STREAM MANAGER – ADVANCED
 * - dynamic list watcher
 * - cache stream_url
 * - auto add/remove streams
 * - final dash report
 * - Telegram bot commands
 * - 1:50 minute delay for ALL servers
 ******************************************************************/

import fs from "fs";
import ffmpeg from "fluent-ffmpeg";
import fetch from "node-fetch";

/* ================= CONFIG ================= */

const CONFIG = {
  streamsApi: "https://ani-box-nine.vercel.app/api/grok-chat",
  pollInterval: 20000,
  telegram: {
    botToken: "7971806903:AAHwpdNzkk6ClL3O17JVxZnp5e9uI66L9WE",
    chatId: "-1002181683719",
  },
  startupDelay: 110000, // 1 minute 50 seconds in milliseconds for ALL servers
};

const CACHE_FILE = "./streams_cache.json";

/* ================= STATE ================= */

let systemState = "running";
let apiItems = new Map(); // current api list
let activeStreams = new Map(); // ffmpeg processes
let streamCache = new Map(); // stream_url cache
let streamStartTimes = new Map(); // track stream start times
let startupTimer = null; // for startup delay

/* ================= CACHE ================= */

function loadCache() {
  if (!fs.existsSync(CACHE_FILE)) return;
  const json = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  Object.entries(json).forEach(([k, v]) => streamCache.set(k, v));
}

function saveCache() {
  const o = {};
  streamCache.forEach((v, k) => (o[k] = v));
  fs.writeFileSync(CACHE_FILE, JSON.stringify(o, null, 2));
}

/* ================= LOGGER ================= */

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

/* ================= TELEGRAM ================= */

async function tg(msg, chatId = CONFIG.telegram.chatId) {
  try {
    await fetch(
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
  } catch (error) {
    console.error("Telegram send error:", error);
  }
}

/* ================= FACEBOOK ================= */

async function createLive(token, name) {
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
  return j.id;
}

async function getStreamAndDash(liveId, token) {
  const fields = "stream_url,dash_preview_url,status";
  for (let i = 0; i < 6; i++) {
    const r = await fetch(
      `https://graph.facebook.com/v24.0/${liveId}?fields=${fields}&access_token=${token}`
    );
    const j = await r.json();
    if (j.stream_url) {
      return {
        stream_url: j.stream_url,
        dash: j.dash_preview_url || "N/A",
        status: j.status || "UNKNOWN",
      };
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("Preview not ready");
}

/* ================= FFMPEG ================= */

function startFFmpeg(item) {
  const cache = streamCache.get(item.id);
  if (!cache) {
    log(`❌ No cache for ${item.name}, cannot start`);
    return;
  }

  log(`▶ STARTING ${item.name}`);
  streamStartTimes.set(item.id, Date.now());

  const cmd = ffmpeg(item.source)
    .inputOptions(["-re"])
    .outputOptions(["-c", "copy", "-f", "flv"])
    .output(cache.stream_url)
    .on("start", () => {
      log(`✅ FFmpeg started for ${item.name}`);
    })
    .on("error", (err) => {
      log(`FFmpeg error for ${item.name}: ${err.message}`);
      restartFFmpeg(item);
    })
    .on("end", () => {
      log(`FFmpeg ended for ${item.name}`);
      restartFFmpeg(item);
    })
    .on("stderr", (stderrLine) => {
      // Optional: Log ffmpeg output
      console.log(`[FFMPEG ${item.name}] ${stderrLine}`);
    });

  activeStreams.set(item.id, cmd);
  cmd.run();
}

function stopFFmpeg(id) {
  try {
    const proc = activeStreams.get(id);
    if (proc) {
      proc.kill("SIGKILL");
      streamStartTimes.delete(id);
      log(`⏹️ Stopped ${id}`);
    }
  } catch (err) {
    console.error(`Error stopping ${id}:`, err);
  }
  activeStreams.delete(id);
}

function restartFFmpeg(item) {
  if (systemState !== "running") return;
  log(`🔄 Restarting ${item.name} in 60 seconds...`);
  stopFFmpeg(item.id);
  setTimeout(() => startFFmpegWithDelay(item), 60000);
}

/* ================= DELAYED START FUNCTION ================= */

function startFFmpegWithDelay(item) {
  const delayMs = CONFIG.startupDelay;
  log(`⏰ ${item.name} will start in ${delayMs / 1000} seconds`);

  setTimeout(() => {
    if (systemState === "running") {
      startFFmpeg(item);
    }
  }, delayMs);
}

/* ================= UPTIME CALCULATION ================= */

function formatUptime(startTime) {
  if (!startTime) return "Not active";

  const uptimeMs = Date.now() - startTime;
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
    hostname: require("os").hostname(),
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    uptime: formatUptime(process.uptime() * 1000),
    memory: {
      used: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`,
      total: `${Math.round(require("os").totalmem() / 1024 / 1024)}MB`,
    },
    streams: {
      active: activeStreams.size,
      total: apiItems.size,
      cached: streamCache.size,
    },
    time: new Date().toLocaleString(),
    startupDelay: `${CONFIG.startupDelay / 1000} seconds`,
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
  report += `• Startup Delay: ${serverInfo.startupDelay}\n\n`;

  report += `📡 <b>Stream Stats:</b>\n`;
  report += `• Active: ${serverInfo.streams.active}\n`;
  report += `• Total: ${serverInfo.streams.total}\n`;
  report += `• Cached: ${serverInfo.streams.cached}\n\n`;

  report += `🎬 <b>Active Streams:</b>\n`;

  let streamCount = 0;
  for (const [id, cache] of streamCache) {
    if (streamCount >= 5) {
      report += `\n... and ${streamCache.size - 5} more streams`;
      break;
    }

    const item = apiItems.get(id);
    const startTime = streamStartTimes.get(id);
    const isActive = activeStreams.has(id);

    if (item) {
      report += `\n<b>${item.name}</b>\n`;
      report += `• Status: ${isActive ? "🟢 LIVE" : "🔴 OFFLINE"}\n`;
      report += `• Uptime: ${formatUptime(startTime)}\n`;
      report += `• DASH: <code>${cache.dash}</code>\n`;
      report += `• Stream URL: ${
        cache.stream_url ? "✅ Configured" : "❌ Missing"
      }\n`;
      report += `• Source: ${item.source ? "✅" : "❌"}\n`;

      streamCount++;
    }
  }

  if (streamCount === 0) {
    report += `\nNo active streams at the moment.\n`;
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
    log(`Error fetching API list: ${error.message}`);
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

          // Wait 1:50 minutes before starting (BOTH NEW AND CACHED)
          startFFmpegWithDelay(item);
        } catch (error) {
          log(`Error creating live for ${item.name}: ${error.message}`);
        }
      }
    }

    /* ❌ REMOVED ITEMS */
    for (const [id] of apiItems) {
      if (!newList.has(id)) {
        log(`❌ REMOVED ITEM ${id}`);
        stopFFmpeg(id);
        streamCache.delete(id);
        streamStartTimes.delete(id);
        saveCache();
      }
    }

    apiItems = newList;
  } catch (error) {
    log(`Watcher error: ${error.message}`);
  }
}

/* ================= TELEGRAM BOT COMMANDS ================= */

let lastCommandTime = new Map(); // Prevent command spam

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
    if (command === "/info" || command === "/info@your_bot_username") {
      const report = await generateInfoReport();
      await tg(report, chatId);
      return;
    }

    // Handle /status command (short version)
    if (command === "/status" || command === "/status@your_bot_username") {
      const status =
        `📊 <b>Stream Manager Status</b>\n\n` +
        `🟢 Active Streams: ${activeStreams.size}\n` +
        `📋 Total Items: ${apiItems.size}\n` +
        `⏰ Server Uptime: ${formatUptime(process.uptime() * 1000)}\n` +
        `⏳ Startup Delay: ${CONFIG.startupDelay / 1000}s\n` +
        `🕒 Time: ${new Date().toLocaleString()}\n\n` +
        `Use /info for detailed report`;
      await tg(status, chatId);
      return;
    }

    // Handle /help command
    if (command === "/help" || command === "/help@your_bot_username") {
      const helpText =
        `🤖 <b>Stream Manager Bot Commands</b>\n\n` +
        `/info - Get detailed system and stream report\n` +
        `/status - Quick status check\n` +
        `/help - Show this help message\n\n` +
        `<i>Auto-monitoring ${CONFIG.pollInterval / 1000}s intervals</i>\n` +
        `<i>All streams start after ${CONFIG.startupDelay / 1000}s delay</i>`;
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
    lines.push(
      `<b>${item ? item.name : id}</b>\n` +
        `DASH: <code>${v.dash}</code>\n` +
        `Uptime: ${formatUptime(startTime)}`
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
    const delaySeconds = CONFIG.startupDelay / 1000;
    await tg(
      `🚀 <b>Stream Manager Started</b>\n\n` +
        `Total items: ${apiItems.size}\n` +
        `Cached streams: ${streamCache.size}\n` +
        `⏳ All streams will start in ${delaySeconds} seconds\n` +
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

    // ⭐ IMPORTANT: Wait 1 minute 50 seconds before starting ALL servers
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
    }, CONFIG.startupDelay);

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
      `Stopping ${activeStreams.size} active streams`
  );

  // Stop all streams
  for (const [id] of activeStreams) {
    stopFFmpeg(id);
  }

  // Wait a bit for processes to terminate
  await new Promise((r) => setTimeout(r, 2000));

  log("👋 Shutdown complete");
  process.exit(0);
}

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);
