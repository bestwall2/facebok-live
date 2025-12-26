/******************************************************************
 * FACEBOOK MULTI STREAM MANAGER – ADVANCED
 * - dynamic list watcher
 * - cache stream_url with creation time
 * - auto add/remove streams
 * - final dash report
 * - Telegram bot commands
 * - 1:50 minute initial delay for ALL servers
 * - 30 second delay for NEW servers
 * - 2 minute delay for CRASHED servers
 * - 3:45 hour stream key rotation (based on creation time)
 * - Server shutdown reports
 * - /restart command
 * - Token error reporting
 * - Enhanced buffering
 * - FIXED: Cache synchronization with stable IDs
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
  initialDelay: 50000, // 50 seconds for ALL servers initial start
  newServerDelay: 30000, // 30 seconds for NEW servers
  crashedServerDelay: 120000, // 2 minutes for CRASHED servers
  rotationInterval: 13500000, // 3:45 hours in milliseconds
};

const CACHE_FILE = "./streams_cache.json";

/* ================= STATE ================= */

let systemState = "running";
let apiItems = new Map(); // current api list with STABLE IDs
let activeStreams = new Map(); // ffmpeg processes
let streamCache = new Map(); // stream_url cache WITH creationTime
let streamStartTimes = new Map(); // track stream start times
let streamRotationTimers = new Map(); // rotation timers
let restartTimers = new Map(); // restart timers
let serverStates = new Map(); // server states
let startupTimer = null; // for initial startup delay
let isRestarting = false; // flag to prevent multiple restarts
let telegramPollingActive = true; // control telegram polling

/* ================= STABLE ID GENERATION ================= */

function generateStableId(streamData) {
  // Create a deterministic hash from name + source for stable IDs
  const str = `${streamData.name}|${streamData.source}`;
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return `item_${Math.abs(hash).toString(16).substring(0, 8)}`;
}

/* ================= CACHE MANAGEMENT ================= */

function loadCache() {
  if (!fs.existsSync(CACHE_FILE)) {
    log(`📁 Cache file doesn't exist, will create new one`);
    return;
  }
  try {
    const json = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    Object.entries(json).forEach(([k, v]) => {
      // Ensure old cache items get creationTime if missing
      if (!v.creationTime) {
        v.creationTime = Date.now() - Math.random() * 3600000;
        log(`⚠️ Added creationTime to old cache item ${k}`);
      }
      streamCache.set(k, v);
    });
    log(`✅ Loaded ${streamCache.size} cached streams`);
  } catch (error) {
    log(`❌ Error loading cache: ${error.message}`);
    // Create fresh cache if corrupted
    streamCache.clear();
    try {
      fs.writeFileSync(CACHE_FILE, JSON.stringify({}, null, 2));
    } catch (e) {
      log(`❌ Failed to create new cache file: ${e.message}`);
    }
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

async function tg(msg, chatId = CONFIG.telegram.chatId, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

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
          signal: controller.signal
        }
      );

      clearTimeout(timeout);

      const result = await response.json();
      if (!result.ok) {
        log(`❌ Telegram error: ${result.description}`);
      }
      return;
    } catch (error) {
      if (attempt === retries) {
        log(`❌ Telegram send error after ${retries} attempts: ${error.message}`);
      } else {
        log(`⚠️ Telegram attempt ${attempt} failed: ${error.message}, retrying...`);
        await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    }
  }
}

/* ================= FACEBOOK API ================= */

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
    try {
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
    } catch (error) {
      log(`⚠️ Stream URL attempt ${i + 1} failed: ${error.message}`);
      if (i === 5) throw error;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error("Preview not ready");
}

async function createLiveWithTimestamp(token, name) {
  try {
    const liveId = await createLive(token, name);
    const preview = await getStreamAndDash(liveId, token);
    
    return {
      liveId,
      ...preview,
      creationTime: Date.now()
    };
  } catch (error) {
    // Check if it's a token error
    if (error.message.includes("access token") || 
        error.message.includes("token") || 
        error.message.includes("OAuth") ||
        error.message.includes("permission") ||
        error.message.includes("expired") ||
        error.message.includes("invalid")) {
      
      const errorMsg = `❌ <b>TOKEN ERROR for ${name}</b>\n\n` +
                      `Error: ${error.message}\n` +
                      `Time: ${new Date().toLocaleString()}\n` +
                      `Action: Stream will not start until token is fixed`;
      
      log(`🔴 Token error for ${name}: ${error.message}`);
      
      await tg(errorMsg);
      
      throw new Error(`TOKEN_ERROR: ${error.message}`);
    }
    
    throw error;
  }
}

/* ================= CHECK AND ROTATE OLD KEYS ================= */

async function checkAndRotateOldKeys() {
  log(`🔍 Checking for old stream keys (> ${CONFIG.rotationInterval/1000/60/60} hours)...`);
  
  let rotatedCount = 0;
  const now = Date.now();
  
  for (const [id, cache] of streamCache) {
    const item = apiItems.get(id);
    if (!item) continue;
    
    const age = now - cache.creationTime;
    const ageHours = age / (1000 * 60 * 60);
    
    if (age >= CONFIG.rotationInterval) {
      log(`🔄 Stream key for ${item.name} is ${ageHours.toFixed(2)} hours old (needs rotation)`);
      
      const isStreaming = activeStreams.has(id);
      
      if (isStreaming) {
        log(`⏰ Rotating ${item.name} immediately (currently streaming)`);
        await rotateStreamKey(item);
      } else {
        log(`⏰ Creating new key for ${item.name} (not currently streaming)`);
        try {
          const newCache = await createLiveWithTimestamp(item.token, item.name);
          streamCache.set(id, newCache);
          saveCache();
          
          log(`✅ Created new stream key for ${item.name}`);
          
          await tg(
            `🔄 <b>AUTO-KEY ROTATION</b>\n\n` +
            `<b>${item.name}</b>\n` +
            `Old key age: ${ageHours.toFixed(2)} hours\n` +
            `New key created and saved to cache\n` +
            `DASH URL: <code>${newCache.dash}</code>\n` +
            `Status: Will use new key when stream starts`
          );
        } catch (error) {
          log(`❌ Failed to rotate key for ${item.name}: ${error.message}`);
        }
      }
      
      rotatedCount++;
    }
  }
  
  if (rotatedCount > 0) {
    log(`✅ Rotated ${rotatedCount} old stream keys`);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* ================= FFMPEG WITH ENHANCED BUFFERING ================= */

async  function startFFmpeg(item, force = false) {
  const cache = streamCache.get(item.id);
  if (!cache) {
    log(`❌ No cache for ${item.name}, cannot start`);
    return;
  }

  if (activeStreams.has(item.id) && !force) {
    log(`⚠️ ${item.name} is already running, skipping`);
    return;
  }

  const timeUntilRotation = CONFIG.rotationInterval - (Date.now() - cache.creationTime);
  if (timeUntilRotation <= 0) {
    log(`⚠️ ${item.name} has expired key (${((Date.now() - cache.creationTime)/1000/60/60).toFixed(2)} hours old), rotating before starting`);
    rotateStreamKey(item);
    return;
  }

  
  // Wait before starting FFmpeg

    log(`⏳ Waiting 5s before starting ${item.name}`);
    await sleep(5000);
  
  log(`▶ STARTING ${item.name} (key age: ${((Date.now() - cache.creationTime)/1000/60/60).toFixed(2)} hours)`);
  serverStates.set(item.id, "starting");

  if (restartTimers.has(item.id)) {
    clearTimeout(restartTimers.get(item.id));
    restartTimers.delete(item.id);
  }


const cmd = ffmpeg(item.source)
    .inputOptions([
      "-re",
      "-headers", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      "-fflags", "+genpts+igndts+discardcorrupt",
      "-rw_timeout", "20000000",
      "-timeout", "20000000",
      "-reconnect", "1",
      "-reconnect_streamed", "1",
      "-reconnect_at_eof", "1",
      "-reconnect_delay_max", "10",
      "-thread_queue_size", "4096"
    ])
    .videoCodec("libx264")
    .audioCodec("aac")
    .audioChannels(2)
    .audioFrequency(44100)
    .audioBitrate("128k")
    .outputOptions([
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-profile:v", "main",
      "-level", "4.1",
      "-pix_fmt", "yuv420p",
      "-r", "30",
      "-g", "60",
      "-keyint_min", "60",
      "-sc_threshold", "0",
      "-b:v", "4500k",
      "-maxrate", "4500k",
      "-bufsize", "9000k",
      "-x264opts", "nal-hrd=cbr:force-cfr=1",
  
      "-c:a", "aac",
      "-b:a", "128k",
      "-ac", "2",
      "-ar", "48000",
  
      "-f", "flv",
      "-rtmp_live", "live",
      "-max_muxing_queue_size", "2048"
    ])
    .output(cache.stream_url)
    .on("start", (commandLine) => {
      log(`✅ FFmpeg started for ${item.name} with enhanced buffering`);
      streamStartTimes.set(item.id, Date.now());
      serverStates.set(item.id, "running");
      startRotationTimer(item);
    })
    .on("error", (err) => {
      log(`❌ FFmpeg error for ${item.name}: ${err.message}`);
      handleStreamCrash(item, err.message);
    })
    .on("end", () => {
      log(`🔚 FFmpeg ended for ${item.name}`);
      handleStreamCrash(item, "Stream ended unexpectedly");
    })
    .on("stderr", (stderrLine) => {
      const line = stderrLine.trim();
      if (line.includes("buffer") || line.includes("queue") || 
          line.includes("speed") || line.includes("bitrate") ||
          line.includes("muxing") || line.includes("delay")) {
        log(`📊 ${item.name} FFmpeg: ${line}`);
      }
    });

  activeStreams.set(item.id, cmd);
  cmd.run();
}

function handleStreamCrash(item, reason) {
  const state = serverStates.get(item.id);

  if (state === "rotating") {
    log(`🔄 ${item.name} crashed during rotation, will continue rotation process`);
    return;
  }

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

  serverStates.set(item.id, "restarting");
  stopFFmpeg(item.id);

  const restartTimer = setTimeout(() => {
    if (systemState === "running") {
      log(`▶ Attempting restart ${item.name}`);
      startFFmpeg(item);
    }
  }, CONFIG.crashedServerDelay);

  restartTimers.set(item.id, restartTimer);
}

function stopFFmpeg(id, skipReport = false) {
  try {
    const proc = activeStreams.get(id);
    if (proc) {
      proc.kill("SIGTERM");
      setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {}
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
  if (streamRotationTimers.has(item.id)) {
    clearTimeout(streamRotationTimers.get(item.id));
  }

  const cache = streamCache.get(item.id);
  if (!cache) return;

  const timeUntilRotation = CONFIG.rotationInterval - (Date.now() - cache.creationTime);
  
  if (timeUntilRotation <= 0) {
    log(`⏰ ${item.name} key has expired, rotating now`);
    rotateStreamKey(item);
    return;
  }

  const minutesLeft = Math.round(timeUntilRotation / 1000 / 60);
  const hoursLeft = (timeUntilRotation / 1000 / 60 / 60).toFixed(1);
  log(`⏰ Rotation timer for ${item.name}: ${minutesLeft} minutes (${hoursLeft} hours) remaining`);

  const rotationTimer = setTimeout(async () => {
    log(`🔄 Rotating stream key for ${item.name} (3:45 hours since creation)`);
    await rotateStreamKey(item);
  }, timeUntilRotation);

  streamRotationTimers.set(item.id, rotationTimer);
}

async function rotateStreamKey(item) {
  try {
    log(`🔄 Starting key rotation for ${item.name}`);
    serverStates.set(item.id, "rotating");

    stopFFmpeg(item.id, true);

    log(`🌐 Creating new live stream for ${item.name}`);
    const newCache = await createLiveWithTimestamp(item.token, item.name);

    streamCache.set(item.id, newCache);
    saveCache();

    const creationTimeFormatted = new Date(newCache.creationTime).toLocaleString();
    await tg(
      `🔄 <b>STREAM KEY ROTATED</b>\n\n` +
        `<b>${item.name}</b>\n` +
        `Old key: Removed\n` +
        `New key: Generated\n` +
        `DASH URL: <code>${newCache.dash}</code>\n` +
        `Created at: ${creationTimeFormatted}\n` +
        `Status: Will start in 30 seconds`
    );

    log(`⏰ ${item.name} will start with new key in 30 seconds`);

    setTimeout(() => {
      if (systemState === "running") {
        startFFmpeg(item);
      }
    }, CONFIG.newServerDelay);
  } catch (error) {
    log(`❌ Rotation failed for ${item.name}: ${error.message}`);
    serverStates.set(item.id, "failed");

    setTimeout(() => {
      if (systemState === "running") {
        log(`🔄 Retrying rotation for ${item.name}`);
        rotateStreamKey(item);
      }
    }, 300000);
  }
}

/* ================= SYSTEM RESTART ================= */

async function restartSystem() {
  if (isRestarting) {
    log("⚠️ System is already restarting, skipping...");
    return;
  }
  
  isRestarting = true;
  log("🔄 SYSTEM RESTART COMMAND RECEIVED");
  
  systemState = "restarting";
  
  await tg("🔁 <b>System Restart Initiated</b>\nStopping all streams and cleaning up...");
  
  if (startupTimer) {
    clearTimeout(startupTimer);
  }
  
  restartTimers.forEach((timer, id) => {
    clearTimeout(timer);
  });
  restartTimers.clear();
  
  streamRotationTimers.forEach((timer, id) => {
    clearTimeout(timer);
  });
  streamRotationTimers.clear();
  
  for (const [id] of activeStreams) {
    stopFFmpeg(id, true);
  }
  
  activeStreams.clear();
  streamStartTimes.clear();
  serverStates.clear();
  
  await new Promise(r => setTimeout(r, 3000));
  
  systemState = "running";
  isRestarting = false;
  
  log("🔄 Restarting system from scratch...");
  await tg("✅ <b>Cleanup Complete</b>\nNow booting up fresh system...");
  
  boot();
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

function formatTimeSinceCreation(itemId) {
  const cache = streamCache.get(itemId);
  if (!cache || !cache.creationTime) return "Unknown";
  
  const age = Date.now() - cache.creationTime;
  return formatUptime(age);
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
    crashedServerDelay: `${CONFIG.crashedServerDelay / 1000} seconds (2 minutes)`,
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
  report += `• API Items: ${serverInfo.streams.total}\n`;
  report += `• Cache Entries: ${serverInfo.streams.cached}\n`;
  report += `• Active Streams: ${serverInfo.streams.active}\n`;
  
  // Sync status
  const syncStatus = serverInfo.streams.total === serverInfo.streams.cached ? "✅ Synced" : "⚠️ Out of sync";
  report += `• Cache Sync: ${syncStatus}\n`;
  
  if (serverInfo.streams.total !== serverInfo.streams.cached) {
    const diff = Math.abs(serverInfo.streams.total - serverInfo.streams.cached);
    report += `• Mismatch: ${diff} item(s)\n`;
  }
  
  report += `\n🎬 <b>Stream Status:</b>\n`;

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
      const keyAge = formatTimeSinceCreation(id);
      const creationTime = cache.creationTime ? 
        new Date(cache.creationTime).toLocaleTimeString() : "Unknown";
      
      report += `\n<b>${item.name}</b>\n`;
      report += `• Status: ${state || "unknown"}\n`;
      report += `• Active: ${isActive ? "🟢" : "🔴"}\n`;
      report += `• Stream Uptime: ${formatUptime(
        startTime ? Date.now() - startTime : 0
      )}\n`;
      report += `• Key Age: ${keyAge} (created: ${creationTime})\n`;
      report += `• DASH: <code>${cache.dash}</code>\n`;

      streamCount++;
    }
  }

  if (streamCount === 0) {
    report += `\nNo active streams.\n`;
  }

  report += `\n🔄 <i>Last checked: ${now.toLocaleTimeString()}</i>`;

  return report;
}

/* ================= API FETCH WITH STABLE IDS ================= */

async function fetchApiList() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    
    const r = await fetch(CONFIG.streamsApi, {
      signal: controller.signal
    });
    
    clearTimeout(timeout);
    const j = await r.json();
    
    const map = new Map();
    if (j.data && Array.isArray(j.data)) {
      j.data.forEach((streamData) => {
        const id = generateStableId(streamData); // STABLE ID
        map.set(id, {
          id: id,
          name: streamData.name,
          token: streamData.token,
          source: streamData.source,
        });
      });
    }
    return map;
  } catch (error) {
    log(`❌ Error fetching API list: ${error.message}`);
    return new Map(); // Return empty map on error
  }
}

/* ================= FULL CACHE SYNCHRONIZATION ================= */

async function synchronizeCacheWithApi() {
  const newApiItems = await fetchApiList();
  
  log(`🔄 Starting cache synchronization...`);
  log(`📊 API: ${newApiItems.size} items, Cache: ${streamCache.size} entries`);
  
  // 1. Remove cache entries that no longer exist in API
  let removedCount = 0;
  for (const [cacheId] of streamCache) {
    if (!newApiItems.has(cacheId)) {
      log(`🧹 Removing orphaned cache: ${cacheId}`);
      
      // Clean up timers
      if (restartTimers.has(cacheId)) {
        clearTimeout(restartTimers.get(cacheId));
        restartTimers.delete(cacheId);
      }
      if (streamRotationTimers.has(cacheId)) {
        clearTimeout(streamRotationTimers.get(cacheId));
        streamRotationTimers.delete(cacheId);
      }
      
      // Stop FFmpeg if running
      stopFFmpeg(cacheId, true);
      
      // Remove from state maps
      streamCache.delete(cacheId);
      streamStartTimes.delete(cacheId);
      serverStates.delete(cacheId);
      
      removedCount++;
    }
  }
  
  // 2. Create cache entries for new API items
  let addedCount = 0;
  for (const [id, item] of newApiItems) {
    if (!streamCache.has(id)) {
      log(`🆕 Creating cache for: ${item.name}`);
      try {
        const newCache = await createLiveWithTimestamp(item.token, item.name);
        streamCache.set(id, newCache);
        addedCount++;
        log(`✅ Created cache for ${item.name}`);
      } catch (error) {
        log(`❌ Failed to create cache for ${item.name}: ${error.message}`);
        if (error.message.includes("TOKEN_ERROR")) {
          serverStates.set(id, "token_error");
        }
      }
    }
  }
  
  // 3. Save updated cache
  if (removedCount > 0 || addedCount > 0) {
    saveCache();
    log(`✅ Sync complete: Removed ${removedCount}, Added ${addedCount}`);
  }
  
  // 4. Update global apiItems
  apiItems = newApiItems;
  
  // 5. Verify synchronization
  log(`📊 Final state: API=${apiItems.size}, Cache=${streamCache.size}`);
  
  if (apiItems.size !== streamCache.size) {
    log(`⚠️ Cache/API mismatch after sync! API: ${apiItems.size}, Cache: ${streamCache.size}`);
    // Force cleanup of any remaining orphans
    const orphanedIds = [];
    for (const [cacheId] of streamCache) {
      if (!apiItems.has(cacheId)) {
        orphanedIds.push(cacheId);
      }
    }
    if (orphanedIds.length > 0) {
      log(`🧹 Removing ${orphanedIds.length} remaining orphans`);
      orphanedIds.forEach(id => streamCache.delete(id));
      saveCache();
    }
  }
  
  return { removedCount, addedCount };
}

/* ================= WATCHER (USES FULL SYNC) ================= */

async function watcher() {
  try {
    const syncResult = await synchronizeCacheWithApi();
    
    // Start streams for newly added items (with delay)
    if (syncResult.addedCount > 0) {
      log(`⏰ ${syncResult.addedCount} new items will start in ${CONFIG.newServerDelay/1000} seconds`);
      setTimeout(() => {
        for (const [id, item] of apiItems) {
          // Only start if we have cache and not already running
          if (streamCache.has(id) && !activeStreams.has(id) && serverStates.get(id) !== "token_error") {
            startFFmpeg(item);
          }
        }
      }, CONFIG.newServerDelay);
    }
    
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
    const command = message.text.trim().toLowerCase();
    const now = Date.now();

    if (lastCommandTime.has(userId)) {
      const lastTime = lastCommandTime.get(userId);
      if (now - lastTime < 5000) {
        await tg("⏳ Please wait 5 seconds between commands.", chatId);
        return;
      }
    }
    lastCommandTime.set(userId, now);

    if (lastCommandTime.size > 100) {
      const oldest = Array.from(lastCommandTime.entries())
        .sort((a, b) => a[1] - b[1])
        .slice(0, 20);
      oldest.forEach(([uid]) => lastCommandTime.delete(uid));
    }

    if (command === "/restart") {
      await tg("🔄 <b>Restarting Stream Manager...</b>\nThis will take a moment...", chatId);
      await restartSystem();
      return;
    }

    if (command === "/info" || command.startsWith("/info")) {
      const report = await generateInfoReport();
      await tg(report, chatId);
      return;
    }

    if (command === "/status" || command.startsWith("/status")) {
      const status =
        `📊 <b>Stream Manager Status</b>\n\n` +
        `🟢 Active Streams: ${activeStreams.size}\n` +
        `📋 API Items: ${apiItems.size}\n` +
        `💾 Cache Entries: ${streamCache.size}\n` +
        `⏰ Server Uptime: ${formatUptime(process.uptime() * 1000)}\n` +
        `🆕 New Server Delay: ${CONFIG.newServerDelay / 1000}s\n` +
        `🔧 Crashed Server Delay: ${CONFIG.crashedServerDelay / 1000}s\n` +
        `⏳ Rotation: ${CONFIG.rotationInterval / (1000 * 60 * 60)}h\n` +
        `🕒 Time: ${new Date().toLocaleString()}\n\n` +
        `Use /info for detailed report\n` +
        `Use /restart to restart system`;
      await tg(status, chatId);
      return;
    }

    if (command === "/help" || command.startsWith("/help")) {
      const helpText =
        `🤖 <b>Stream Manager Bot Commands</b>\n\n` +
        `/info - Get detailed system and stream report\n` +
        `/status - Quick status check\n` +
        `/restart - Restart the entire system\n` +
        `/help - Show this help message\n\n` +
        `<i>Auto-monitoring ${CONFIG.pollInterval / 1000}s intervals</i>\n` +
        `<i>New server delay: ${CONFIG.newServerDelay / 1000}s</i>\n` +
        `<i>Crashed server delay: ${CONFIG.crashedServerDelay / 1000}s</i>\n` +
        `<i>Rotation interval: ${CONFIG.rotationInterval / (1000 * 60 * 60)}h</i>`;
      await tg(helpText, chatId);
    }
  } catch (error) {
    console.error("Command handler error:", error);
  }
}

/* ================= TELEGRAM POLLING ================= */

async function telegramBotPolling() {
  let offset = 0;
  let errorCount = 0;
  const maxErrors = 10;

  while (systemState === "running" && telegramPollingActive) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 35000);

      const response = await fetch(
        `https://api.telegram.org/bot${CONFIG.telegram.botToken}/getUpdates?offset=${offset}&timeout=30`,
        { signal: controller.signal }
      );

      clearTimeout(timeout);

      const data = await response.json();

      if (data.ok && data.result.length > 0) {
        errorCount = 0;
        for (const update of data.result) {
          offset = update.update_id + 1;
          await handleTelegramCommand(update);
        }
      } else if (!data.ok) {
        log(`⚠️ Telegram API error: ${data.description}`);
        errorCount++;
      }
    } catch (error) {
      errorCount++;
      
      if (error.name === "AbortError") {
        log("⏱️ Telegram polling timeout, retrying...");
      } else {
        log(`⚠️ Telegram polling error (${errorCount}/${maxErrors}): ${error.message}`);
      }

      const waitTime = errorCount > 5 ? 30000 : 5000;
      await new Promise((r) => setTimeout(r, waitTime));

      if (errorCount >= maxErrors) {
        log("⚠️ Too many Telegram errors, restarting polling...");
        errorCount = 0;
        await new Promise((r) => setTimeout(r, 60000));
      }
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
    const keyAge = formatTimeSinceCreation(id);
    
    lines.push(
      `<b>${item ? item.name : id}</b>\n` +
        `Status: ${state || "unknown"}\n` +
        `Key Age: ${keyAge}\n` +
        `DASH: <code>${v.dash}</code>\n` +
        `Uptime: ${formatUptime(startTime ? Date.now() - startTime : 0)}`
    );
  });

  await tg(`📡 <b>DASH REPORT</b>\n\n${lines.join("\n\n")}`);
}

/* ================= BOOT WITH PROPER SYNCHRONIZATION ================= */

async function boot() {
  log("🚀 Booting Stream Manager...");

  try {
    // 1. Load existing cache
    loadCache();
    
    // 2. Perform initial synchronization
    log(`🔄 Performing initial cache synchronization...`);
    const syncResult = await synchronizeCacheWithApi();
    
    log(`📋 Loaded ${apiItems.size} items from API`);
    log(`💾 Loaded ${streamCache.size} cached streams`);
    
    // 3. Check for old stream keys
    log(`🔍 Checking for old stream keys on startup...`);
    await checkAndRotateOldKeys();
    
    // 4. Send startup notification
    const delaySeconds = CONFIG.initialDelay / 1000;
    await tg(
      `🚀 <b>Stream Manager Started</b>\n\n` +
      `API Items: ${apiItems.size}\n` +
      `Cache Entries: ${streamCache.size}\n` +
      `Sync Status: ${syncResult.removedCount} removed, ${syncResult.addedCount} added\n` +
      `Checked old keys: ✅ Done\n` +
      `⏳ All streams will start in ${delaySeconds} seconds\n` +
      `🆕 New server delay: ${CONFIG.newServerDelay / 1000}s\n` +
      `🔧 Crashed server delay: ${CONFIG.crashedServerDelay / 1000}s\n` +
      `🔄 Auto-rotation: ${CONFIG.rotationInterval / (1000 * 60 * 60)} hours\n` +
      `Bot commands: /info /status /restart /help`
    );
    
    // 5. Wait before starting all servers
    log(`⏳ Waiting ${delaySeconds} seconds before starting all servers...`);
    
    startupTimer = setTimeout(() => {
      log(`▶ Starting ALL servers after ${delaySeconds} second delay`);
      
      // Start servers that have cache and no token errors
      let startedCount = 0;
      for (const [id, item] of apiItems) {
        if (streamCache.has(id) && serverStates.get(id) !== "token_error") {
          startFFmpeg(item);
          startedCount++;
        }
      }
      
      log(`✅ Started ${startedCount}/${apiItems.size} servers`);
      
      // 6. Start periodic watcher
      setInterval(watcher, CONFIG.pollInterval);
      log(`🔍 Watcher started with ${CONFIG.pollInterval / 1000}s intervals`);
      
      // 7. Start old key checker
      setInterval(checkAndRotateOldKeys, 3600000);
      log(`🔍 Old key checker started (every hour)`);
      
      // 8. Send final report
      setTimeout(finalCheckReport, 300000);
      log(`📊 Final report scheduled in 5 minutes`);
    }, CONFIG.initialDelay);
    
    // 9. Start Telegram bot polling
    telegramBotPolling();
    log(`🤖 Telegram bot polling started`);
    
  } catch (error) {
    log(`❌ Boot failed: ${error.message}`);
    await tg(`❌ <b>Stream Manager Boot Failed</b>\n${error.message}\n\nTry /restart to try again.`);
    setTimeout(boot, 60000);
  }
}

/* ================= SHUTDOWN ================= */

async function gracefulShutdown() {
  systemState = "stopping";
  telegramPollingActive = false;
  log("🛑 Shutting down gracefully...");

  if (startupTimer) {
    clearTimeout(startupTimer);
  }

  await tg(
    "🛑 <b>Stream Manager Shutting Down</b>\n" +
      `Stopping ${activeStreams.size} active streams\n` +
      `Cleaning up all timers`
  );

  restartTimers.forEach((timer, id) => {
    clearTimeout(timer);
  });
  streamRotationTimers.forEach((timer, id) => {
    clearTimeout(timer);
  });

  for (const [id] of activeStreams) {
    stopFFmpeg(id, true);
  }

  await new Promise((r) => setTimeout(r, 2000));

  log("👋 Shutdown complete");
  process.exit(0);
}

/* ================= START THE SYSTEM ================= */

boot();

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);
