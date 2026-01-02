
import fs from "fs";
import { spawn } from "child_process";
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
  initialDelay: 30000, // Reduced to 30 seconds for faster startup
  newServerDelay: 15000, // 15 seconds for NEW servers
  crashedServerDelay: 45000, // 45 seconds for CRASHED servers
  rotationInterval: 13500000, // 3:45 hours in milliseconds

  // Optimized for 20+ servers
  maxConcurrentConnects: 8, // Reduced to avoid overwhelming network/CPU
  maxActiveStreams: 25, // Maximum active streams allowed
  connectStabilityWindow: 5000, // Reduced to 5 seconds
  connectTimeout: 15000, // 15 seconds timeout
  startupBackoffBase: 15000, // Base backoff for startup failures
  startupBackoffCap: 5 * 60_000, // cap (5 min)
  globalFailureThreshold: 6, // Increased threshold
  globalFailureWindow: 120_000, // Increased timeframe
  globalCooldownDuration: 60_000, // 1 minute cooldown

  // FFmpeg optimizations
  ffmpegBufferSize: "4M", // Buffer size
  ffmpegThreadQueueSize: 512, // Reduced thread queue
  ffmpegProbeSize: "2M", // Smaller probe size
  ffmpegAnalyzeDuration: "2M", // Smaller analyze duration
  ffmpegReconnectAttempts: 10, // Reconnect attempts
  ffmpegMaxReconnectDelay: 5, // Max reconnect delay
  ffmpegRwTimeout: "10000000", // Read/write timeout

  // Group restart behavior
  restartGroupOnTokenFailure: true,

  // Facebook Post Configuration
  facebookPost: {
    postId: "100985439354836_841453868647870",
    accessToken: "EAAKXMxkBFCIBQVBZCq13bO5Jje0ZCkX7igrViPXwbBBkvWRHKkXzaHxWZBF6w1DGc0eutZCAbUFJMMA7ElvMMIMwLOhn7YrNyXJggg1sIjDKsQfWgHNyrR61Gy2x09VaTyZCzYqZB96fW1yWYL2HYyVTTjBfiBbhUpF8Ooun7z0wU11FjJGm1p0VGdKffm3U1U598GB1n2sQ4uFSh4F1YeZCSEZD",
  },
  
  // Performance monitoring
  healthCheckInterval: 30000, // 30 seconds
  maxMemoryUsage: 0.8, // 80% max memory usage
  cpuCheckThreshold: 70, // CPU usage threshold
};

const CACHE_FILE = "./streams_cache.json";
const LOG_FILE = "./stream_manager.log";

/* ================= STATE ================= */

let systemState = "running";
let apiItems = new Map();
let activeStreams = new Map();
let streamCache = new Map();
let streamStartTimes = new Map();
let streamRotationTimers = new Map();
let restartTimers = new Map();
let serverStates = new Map();
let startupTimer = null;
let isRestarting = false;
let telegramPollingActive = true;

// Performance tracking
let performanceStats = {
  totalConnections: 0,
  failedConnections: 0,
  successfulConnections: 0,
  avgStreamUptime: 0,
  lastHealthCheck: Date.now(),
  memoryUsage: [],
  cpuUsage: [],
};

// Orchestration-specific
let availableConnectSlots = CONFIG.maxConcurrentConnects;
const startQueue = [];
const connectionHolders = new Map();
const perStreamAttempts = new Map();
let recentStartupFailures = [];
let globalCooldownUntil = 0;
const groupRestartTimers = new Map();

// NEW: Stream health tracking
const streamHealth = new Map(); // id -> { lastDataTime, errors, bitrate }

/* ================= LOGGER WITH FILE ================= */

const log = (m) => {
  const timestamp = new Date().toISOString();
  const message = `[${timestamp}] ${m}`;
  console.log(message);
  
  // Append to log file
  try {
    fs.appendFileSync(LOG_FILE, message + '\n', 'utf8');
  } catch (error) {
    // Silently fail if log file can't be written
  }
};

/* ================= ENHANCED STABLE ID GENERATION ================= */

function generateStableId(streamData) {
  const str = `${streamData.name}|${streamData.source}|${streamData.token}`;
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return `item_${Math.abs(hash).toString(16).substring(0, 10)}`;
}

/* ================= ENHANCED CACHE MANAGEMENT ================= */

function loadCache() {
  if (!fs.existsSync(CACHE_FILE)) {
    log(`📁 Cache file doesn't exist, will create new one`);
    return;
  }
  try {
    const json = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    const now = Date.now();
    let loadedCount = 0;
    
    Object.entries(json).forEach(([k, v]) => {
      // Skip cache entries older than 24 hours
      if (v.creationTime && (now - v.creationTime) > 24 * 60 * 60 * 1000) {
        log(`🗑️ Skipping old cache entry ${k} (older than 24h)`);
        return;
      }
      
      if (!v.creationTime) {
        v.creationTime = Date.now() - Math.random() * 3600000;
      }
      streamCache.set(k, v);
      loadedCount++;
    });
    
    log(`✅ Loaded ${loadedCount} cached streams (filtered old entries)`);
  } catch (error) {
    log(`❌ Error loading cache: ${error.message}`);
    streamCache.clear();
    try {
      fs.writeFileSync(CACHE_FILE, JSON.stringify({}, null, 2));
    } catch (e) {}
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

/* ================= OPTIMIZED TELEGRAM ================= */

async function tg(msg, chatId = CONFIG.telegram.chatId, retries = 2) {
  // Skip telegram in bulk operations to avoid rate limiting
  if (systemState === "starting_bulk") return;
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000); // Reduced timeout

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
      await response.json(); // Don't need the result
      return;
    } catch (error) {
      if (attempt === retries) {
        log(`❌ Telegram send error: ${error.message}`);
      }
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
}

/* ================= OPTIMIZED FACEBOOK API ================= */

async function createLive(token, name) {
  log(`🌐 Creating Facebook Live for: ${name}`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const r = await fetch("https://graph.facebook.com/v24.0/me/live_videos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: name.substring(0, 100), // Truncate to avoid errors
        status: "UNPUBLISHED",
        access_token: token,
      }),
      signal: controller.signal
    });
    
    clearTimeout(timeout);
    const j = await r.json();
    
    if (j.error) {
      throw new Error(j.error.message);
    }
    
    log(`✅ Created Live ID: ${j.id}`);
    return j.id;
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
}

async function getStreamAndDash(liveId, token) {
  log(`🌐 Getting stream URL for Live ID: ${liveId}`);
  
  for (let i = 0; i < 3; i++) { // Reduced attempts
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      
      const r = await fetch(
        `https://graph.facebook.com/v24.0/${liveId}?fields=stream_url,dash_preview_url,status&access_token=${token}`,
        { signal: controller.signal }
      );
      
      clearTimeout(timeout);
      const j = await r.json();
      
      if (j.stream_url) {
        log(`✅ Stream URL ready for ${liveId}`);
        return {
          stream_url: j.stream_url,
          dash: j.dash_preview_url || "N/A",
          status: j.status || "UNKNOWN",
        };
      }
      
      await new Promise((r) => setTimeout(r, 1000)); // Reduced wait
    } catch (error) {
      log(`⚠️ Stream URL attempt ${i + 1} failed: ${error.message}`);
      if (i === 2) throw error;
      await new Promise((r) => setTimeout(r, 1000));
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

/* ================= CONNECTION QUEUE OPTIMIZATION ================= */

function tryProcessStartQueue() {
  if (Date.now() < globalCooldownUntil) {
    log(`⏸️ Global cooldown active until ${new Date(globalCooldownUntil).toLocaleTimeString()}`);
    return;
  }

  // Check system resources before starting new streams
  if (!checkSystemResources()) {
    log(`⚠️ System resources low, pausing new connections`);
    return;
  }

  while (availableConnectSlots > 0 && startQueue.length > 0 && activeStreams.size < CONFIG.maxActiveStreams) {
    const next = startQueue.shift();
    availableConnectSlots--;
    connectionHolders.set(next.id, { held: true });
    next.resolve();
  }
}

function enqueueStart(item) {
  return new Promise((resolve) => {
    if (activeStreams.size >= CONFIG.maxActiveStreams) {
      log(`⚠️ Max active streams reached (${CONFIG.maxActiveStreams}), queuing ${item.name}`);
    }

    if (connectionHolders.has(item.id) && connectionHolders.get(item.id).held) {
      resolve();
      return;
    }

    startQueue.push({ id: item.id, resolve });
    tryProcessStartQueue();
  });
}

function releaseConnectSlot(itemId) {
  if (connectionHolders.has(itemId) && connectionHolders.get(itemId).held) {
    connectionHolders.set(itemId, { held: false });
    availableConnectSlots = Math.min(availableConnectSlots + 1, CONFIG.maxConcurrentConnects);
    setImmediate(tryProcessStartQueue);
  }
}

function checkSystemResources() {
  const memoryUsage = process.memoryUsage().heapUsed / os.totalmem();
  if (memoryUsage > CONFIG.maxMemoryUsage) {
    log(`⚠️ High memory usage: ${(memoryUsage * 100).toFixed(1)}%`);
    return false;
  }
  return true;
}

function recordStartupFailure() {
  const now = Date.now();
  recentStartupFailures.push(now);
  recentStartupFailures = recentStartupFailures.filter(ts => now - ts <= CONFIG.globalFailureWindow);
  
  if (recentStartupFailures.length >= CONFIG.globalFailureThreshold) {
    globalCooldownUntil = Date.now() + CONFIG.globalCooldownDuration;
    log(`🚨 Too many startup failures (${recentStartupFailures.length}). Global cooldown for ${CONFIG.globalCooldownDuration/1000}s`);
    
    while (startQueue.length > 0) {
      const queued = startQueue.shift();
      queued.resolve();
    }
    
    recentStartupFailures = [];
  }
}

/* ================= OPTIMIZED FFMPEG ARG BUILDER ================= */

function buildInputArgsForSource(source) {
  const s = String(source || "").trim();
  const lower = s.toLowerCase();

  // Common args for all sources
  const commonArgs = [
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_on_network_error", "1",
    "-reconnect_on_http_error", "4xx,5xx",
    "-reconnect_delay_max", CONFIG.ffmpegMaxReconnectDelay,
    "-rw_timeout", CONFIG.ffmpegRwTimeout,
    "-thread_queue_size", CONFIG.ffmpegThreadQueueSize,
    "-analyzeduration", CONFIG.ffmpegAnalyzeDuration,
    "-probesize", CONFIG.ffmpegProbeSize,
    "-fflags", "+discardcorrupt+genpts+igndts",
    "-err_detect", "ignore_err",
    "-stats",
  ];

  // HLS Streams
  if (/\.m3u8(\?|$)/i.test(s) || lower.includes("m3u8") || lower.includes("hls")) {
    return [
      ...commonArgs,
      "-user_agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "-timeout", "15000000",
      "-max_delay", "5000000",
      "-i", s
    ];
  }

  // RTSP Streams
  if (lower.startsWith("rtsp://")) {
    return [
      ...commonArgs,
      "-rtsp_transport", "tcp",
      "-stimeout", "10000000",
      "-buffer_size", CONFIG.ffmpegBufferSize,
      "-i", s
    ];
  }

  // HTTP Progressive / TS streams
  if (/^https?:\/\//i.test(s) && (s.includes(".ts") || s.includes(".mp4") || s.includes(".m4v"))) {
    return [
      ...commonArgs,
      "-user_agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "-seekable", "0",
      "-i", s
    ];
  }

  // RTMP Streams
  if (lower.startsWith("rtmp://") || lower.startsWith("rtmps://")) {
    return [
      ...commonArgs,
      "-user_agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "-buffer_size", CONFIG.ffmpegBufferSize,
      "-i", s
    ];
  }

  // Default for other sources
  return [
    ...commonArgs,
    "-user_agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "-i", s
  ];
}

function buildOutputArgs(streamUrl) {
  return [
    // Video/Audio
    "-c:v", "copy",
    "-c:a", "copy",
    
    // Timing stabilization
    "-fps_mode", "cfr",
    "-vsync", "1",
    "-avoid_negative_ts", "make_zero",
    
    // Facebook specific
    "-f", "flv",
    "-flvflags", "no_duration_filesize",
    "-rtmp_buffer", "1000",
    "-rtmp_live", "live",
    
    // Performance
    "-preset", "ultrafast",
    "-tune", "zerolatency",
    "-movflags", "+faststart",
    
    // Logging
    "-loglevel", "warning",
    "-hide_banner",
    
    streamUrl
  ];
}

/* ================= OPTIMIZED FFMPEG START ================= */

async function startFFmpeg(item, force = false) {
  const cache = streamCache.get(item.id);
  if (!cache) {
    log(`❌ No cache for ${item.name}, cannot start`);
    return;
  }

  if (activeStreams.has(item.id) && !force) {
    log(`⚠️ ${item.name} is already running`);
    return;
  }

  if (serverStates.get(item.id) === "token_error") {
    log(`⚠️ ${item.name} has token error; skipping`);
    return;
  }

  // Check if stream already has recent data
  const health = streamHealth.get(item.id);
  if (health && Date.now() - health.lastDataTime < 5000) {
    log(`⚠️ ${item.name} has recent data, skipping restart`);
    return;
  }

  // Check key age
  const timeUntilRotation = CONFIG.rotationInterval - (Date.now() - cache.creationTime);
  if (timeUntilRotation <= 0) {
    log(`⚠️ ${item.name} has expired key, rotating`);
    rotateStreamKey(item);
    return;
  }

  // Acquire connection slot
  log(`🧾 Enqueueing ${item.name}`);
  await enqueueStart(item);
  
  if (systemState !== "running") {
    releaseConnectSlot(item.id);
    return;
  }
  
  serverStates.set(item.id, "connecting");
  log(`⏳ ${item.name} connecting...`);

  // Build optimized args
  const source = item.source || "";
  const inputArgs = buildInputArgsForSource(source);
  const outputArgs = buildOutputArgs(cache.stream_url);
  const args = [...inputArgs, ...outputArgs];

  let startTimeout = null;
  let stabilityTimer = null;
  let hadStartEvent = false;
  let slotReleased = false;
  let child = null;
  let lastDataTime = Date.now();

  function ensureReleaseSlot() {
    if (!slotReleased) {
      slotReleased = true;
      releaseConnectSlot(item.id);
    }
  }

  startTimeout = setTimeout(() => {
    if (!hadStartEvent) {
      log(`❌ ${item.name} connection timeout`);
      try { if (child) child.kill("SIGKILL"); } catch (e) {}
      ensureReleaseSlot();
      classifyStartupFailure(item, "Connection timeout");
    }
  }, CONFIG.connectTimeout);

  try {
    child = spawn("ffmpeg", args, { 
      stdio: ["ignore", "pipe", "pipe"],
      detached: false
    });
  } catch (err) {
    log(`❌ spawn() failed for ${item.name}: ${err.message}`);
    ensureReleaseSlot();
    classifyStartupFailure(item, err.message);
    return;
  }

  activeStreams.set(item.id, child);
  streamHealth.set(item.id, { lastDataTime: Date.now(), errors: 0, bitrate: 0 });

  child.on("spawn", () => {
    hadStartEvent = true;
    streamStartTimes.set(item.id, Date.now());
    serverStates.set(item.id, "running");
    log(`✅ ${item.name} started (pid=${child.pid})`);
    
    stabilityTimer = setTimeout(() => {
      ensureReleaseSlot();
    }, CONFIG.connectStabilityWindow);
    
    if (startTimeout) {
      clearTimeout(startTimeout);
      startTimeout = null;
    }
    
    perStreamAttempts.set(item.id, 0);
    startRotationTimer(item);
  });

  // Monitor stderr for health
  child.stderr.on("data", (chunk) => {
    const text = String(chunk);
    streamHealth.get(item.id).lastDataTime = Date.now();
    
    // Parse for bitrate and errors
    const bitrateMatch = text.match(/bitrate=\s*([\d.]+)\s*kb\/s/i);
    if (bitrateMatch) {
      streamHealth.get(item.id).bitrate = parseFloat(bitrateMatch[1]);
    }
    
    if (text.includes("error") || text.includes("failed") || text.includes("timeout")) {
      streamHealth.get(item.id).errors++;
      log(`⚠️ ${item.name} FFmpeg: ${text.substring(0, 100)}`);
    }
  });

  child.on("error", (err) => {
    log(`❌ ${item.name} spawn error: ${err.message}`);
    ensureReleaseSlot();
    activeStreams.delete(item.id);
    
    if (!hadStartEvent) {
      classifyStartupFailure(item, err.message);
    } else {
      handleStreamCrash(item, err.message, { runtime: true });
    }
    
    clearTimers();
  });

  child.on("exit", (code, signal) => {
    log(`🔚 ${item.name} exited: code ${code}, signal ${signal}`);
    activeStreams.delete(item.id);
    
    if (!hadStartEvent) {
      ensureReleaseSlot();
      classifyStartupFailure(item, `Startup exit: ${code}`);
    } else {
      handleStreamCrash(item, `Process exited (${code})`, { runtime: true });
    }
    
    clearTimers();
  });

  function clearTimers() {
    if (startTimeout) {
      clearTimeout(startTimeout);
      startTimeout = null;
    }
    if (stabilityTimer) {
      clearTimeout(stabilityTimer);
      stabilityTimer = null;
    }
  }
}

/* ================= OPTIMIZED STREAM HEALTH CHECK ================= */

function checkStreamHealth() {
  const now = Date.now();
  let healthyCount = 0;
  let unhealthyCount = 0;

  for (const [id, child] of activeStreams) {
    const health = streamHealth.get(id);
    const item = apiItems.get(id);
    
    if (!health || !item) continue;

    const timeSinceData = now - health.lastDataTime;
    
    // If no data for 30 seconds, restart
    if (timeSinceData > 30000 && serverStates.get(id) === "running") {
      log(`⚠️ ${item.name} no data for ${Math.round(timeSinceData/1000)}s, restarting`);
      unhealthyCount++;
      
      // Soft restart first
      try {
        child.kill("SIGTERM");
        setTimeout(() => {
          if (activeStreams.has(id)) {
            child.kill("SIGKILL");
          }
        }, 3000);
      } catch (e) {}
      
      // Schedule restart with short delay
      setTimeout(() => {
        if (systemState === "running" && apiItems.has(id)) {
          startFFmpeg(apiItems.get(id)).catch(() => {});
        }
      }, 5000);
    } else {
      healthyCount++;
    }
  }

  if (unhealthyCount > 0) {
    log(`📊 Health check: ${healthyCount} healthy, ${unhealthyCount} unhealthy`);
  }
}

/* ================= OPTIMIZED CRASH HANDLING ================= */

function handleStreamCrash(item, reason, opts = { runtime: false }) {
  const state = serverStates.get(item.id);

  if (state === "rotating") {
    log(`🔄 ${item.name} crashed during rotation`);
    return;
  }

  const uptime = streamStartTimes.has(item.id)
    ? formatUptime(Date.now() - streamStartTimes.get(item.id))
    : "Unknown";

  if (opts.runtime) {
    log(`🔴 ${item.name} crashed after ${uptime}, restarting in ${CONFIG.crashedServerDelay/1000}s`);

    // Group restart logic
    if (CONFIG.restartGroupOnTokenFailure && item && item.token) {
      const token = item.token;
      
      if (groupRestartTimers.has(token)) {
        serverStates.set(item.id, "restarting");
        stopFFmpeg(item.id);
        return;
      }

      const sameTokenIds = [];
      for (const [id, apiItem] of apiItems) {
        if (apiItem && apiItem.token === token) {
          sameTokenIds.push(id);
        }
      }

      if (sameTokenIds.length > 1) {
        log(`🔁 Group restart for ${sameTokenIds.length} streams with token ${token}`);

        // Stop all streams with same token
        for (const id of sameTokenIds) {
          if (activeStreams.has(id)) {
            stopFFmpeg(id, true);
          }
          if (restartTimers.has(id)) {
            clearTimeout(restartTimers.get(id));
            restartTimers.delete(id);
          }
          serverStates.set(id, "restarting");
        }

        // Schedule group restart
        const groupTimer = setTimeout(() => {
          log(`▶ Group restart for token ${token}`);
          groupRestartTimers.delete(token);

          for (const id of sameTokenIds) {
            const apiItem = apiItems.get(id);
            if (!apiItem) continue;
            if (serverStates.get(id) === "token_error") continue;
            
            // Stagger restarts slightly
            setTimeout(() => {
              startFFmpeg(apiItem).catch(() => {});
            }, Math.random() * 2000);
          }
        }, CONFIG.crashedServerDelay);

        groupRestartTimers.set(token, groupTimer);
        return;
      }
    }

    // Single stream restart
    serverStates.set(item.id, "restarting");
    stopFFmpeg(item.id);

    if (restartTimers.has(item.id)) {
      clearTimeout(restartTimers.get(item.id));
    }
    
    const restartTimer = setTimeout(() => {
      if (systemState === "running") {
        startFFmpeg(item).catch(() => {});
      }
    }, CONFIG.crashedServerDelay);
    
    restartTimers.set(item.id, restartTimer);
  }
}

/* ================= OPTIMIZED STOP FUNCTION ================= */

function stopFFmpeg(id, skipReport = false) {
  try {
    const proc = activeStreams.get(id);
    if (proc) {
      // Try graceful shutdown first
      try { 
        proc.kill("SIGTERM"); 
      } catch {}
      
      // Force kill after 2 seconds
      setTimeout(() => {
        try { 
          if (activeStreams.has(id)) {
            proc.kill("SIGKILL"); 
          }
        } catch {}
      }, 2000);

      if (!skipReport) {
        const state = serverStates.get(id);
        if (state === "running") {
          const item = apiItems.get(id);
          if (item) {
            log(`⏹️ Stopped ${item.name}`);
          }
        }
      }
    }
  } catch (err) {
    log(`❌ Error stopping ${id}: ${err.message}`);
  }

  activeStreams.delete(id);
  streamStartTimes.delete(id);
  streamHealth.delete(id);
  releaseConnectSlot(id);
}

/* ================= OPTIMIZED SYSTEM FUNCTIONS ================= */

function classifyStartupFailure(item, message = "Startup failure") {
  const attempts = (perStreamAttempts.get(item.id) || 0) + 1;
  perStreamAttempts.set(item.id, attempts);

  log(`⚠️ ${item.name} startup failure #${attempts}: ${message}`);
  recordStartupFailure();

  let backoff = Math.min(
    CONFIG.startupBackoffCap,
    CONFIG.startupBackoffBase * Math.pow(1.5, attempts - 1)
  ) + Math.random() * 5000;

  log(`⏰ Retry ${item.name} in ${(backoff / 1000).toFixed(1)}s`);
  serverStates.set(item.id, "restarting");

  if (restartTimers.has(item.id)) {
    clearTimeout(restartTimers.get(item.id));
  }
  
  const timer = setTimeout(() => {
    if (systemState === "running") {
      startFFmpeg(apiItems.get(item.id), true).catch(() => {});
    }
  }, backoff);
  
  restartTimers.set(item.id, timer);
}

function startRotationTimer(item) {
  if (streamRotationTimers.has(item.id)) {
    clearTimeout(streamRotationTimers.get(item.id));
  }

  const cache = streamCache.get(item.id);
  if (!cache) return;

  const timeUntilRotation = CONFIG.rotationInterval - (Date.now() - cache.creationTime);
  
  if (timeUntilRotation <= 0) {
    log(`⏰ ${item.name} key expired, rotating now`);
    rotateStreamKey(item);
    return;
  }

  const hoursLeft = (timeUntilRotation / 1000 / 60 / 60).toFixed(1);
  log(`⏰ ${item.name} rotation in ${hoursLeft} hours`);

  const rotationTimer = setTimeout(async () => {
    log(`🔄 Rotating ${item.name} (3:45 hours)`);
    await rotateStreamKey(item);
  }, timeUntilRotation);

  streamRotationTimers.set(item.id, rotationTimer);
}

async function rotateStreamKey(item) {
  try {
    log(`🔄 Rotating key for ${item.name}`);
    serverStates.set(item.id, "rotating");
    stopFFmpeg(item.id, true);

    const newCache = await createLiveWithTimestamp(item.token, item.name);
    streamCache.set(item.id, newCache);
    saveCache();

    log(`⏰ ${item.name} will start with new key in 30s`);

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
        rotateStreamKey(item);
      }
    }, 300000);
  }
}

async function restartSystem() {
  if (isRestarting) return;
  isRestarting = true;
  log("🔄 SYSTEM RESTART");
  
  systemState = "restarting";
  await tg("🔁 <b>System Restart Initiated</b>");

  // Clear all timers
  if (startupTimer) clearTimeout(startupTimer);
  
  restartTimers.forEach((timer) => clearTimeout(timer));
  restartTimers.clear();
  
  streamRotationTimers.forEach((timer) => clearTimeout(timer));
  streamRotationTimers.clear();
  
  groupRestartTimers.forEach((timer) => clearTimeout(timer));
  groupRestartTimers.clear();

  // Stop all streams
  for (const [id] of activeStreams) {
    stopFFmpeg(id, true);
  }
  
  activeStreams.clear();
  streamStartTimes.clear();
  serverStates.clear();
  streamHealth.clear();
  
  // Reset state
  await new Promise(r => setTimeout(r, 2000));
  systemState = "running";
  isRestarting = false;
  
  log("🔄 Restarting fresh...");
  boot();
}

/* ================= PERFORMANCE MONITORING ================= */

function monitorPerformance() {
  const memoryUsage = process.memoryUsage();
  const totalMemory = os.totalmem();
  const usedPercent = (memoryUsage.heapUsed / totalMemory) * 100;
  
  performanceStats.memoryUsage.push(usedPercent);
  if (performanceStats.memoryUsage.length > 10) {
    performanceStats.memoryUsage.shift();
  }
  
  // Check memory usage
  if (usedPercent > CONFIG.maxMemoryUsage * 100) {
    log(`⚠️ High memory usage: ${usedPercent.toFixed(1)}%`);
    
    // Stop some streams if memory is too high
    if (activeStreams.size > 15) {
      const toStop = Math.ceil(activeStreams.size * 0.1); // Stop 10%
      log(`🛑 Stopping ${toStop} streams due to high memory`);
      
      let stopped = 0;
      for (const [id] of activeStreams) {
        if (stopped >= toStop) break;
        stopFFmpeg(id, true);
        stopped++;
      }
    }
  }
  
  // Log performance stats every 5 minutes
  if (Date.now() - performanceStats.lastHealthCheck > 300000) {
    const avgMemory = performanceStats.memoryUsage.reduce((a, b) => a + b, 0) / performanceStats.memoryUsage.length;
    log(`📊 Performance: Memory ${avgMemory.toFixed(1)}%, Streams ${activeStreams.size}/${apiItems.size}`);
    performanceStats.lastHealthCheck = Date.now();
  }
}

/* ================= OPTIMIZED BOOT SEQUENCE ================= */

async function boot() {
  log("🚀 Booting Stream Manager for 20+ servers...");
  
  try {
    // 1. Load cache
    loadCache();
    
    // 2. Fetch API with retry
    let apiItemsMap = new Map();
    for (let i = 0; i < 3; i++) {
      try {
        apiItemsMap = await fetchApiList();
        if (apiItemsMap.size > 0) break;
        await new Promise(r => setTimeout(r, 2000));
      } catch (e) {
        log(`⚠️ API fetch attempt ${i + 1} failed: ${e.message}`);
      }
    }
    
    if (apiItemsMap.size === 0) {
      throw new Error("No API items received");
    }
    
    apiItems = apiItemsMap;
    log(`📋 Loaded ${apiItems.size} items from API`);
    
    // 3. Create cache for missing items (staggered)
    let createdCount = 0;
    const itemsArray = Array.from(apiItems.entries());
    
    for (let i = 0; i < itemsArray.length; i++) {
      const [id, item] = itemsArray[i];
      
      if (!streamCache.has(id)) {
        try {
          log(`🆕 Creating cache for ${item.name} (${i + 1}/${itemsArray.length})`);
          const newCache = await createLiveWithTimestamp(item.token, item.name);
          streamCache.set(id, newCache);
          createdCount++;
          
          // Save cache every 5 creations
          if (createdCount % 5 === 0) {
            saveCache();
          }
          
          // Delay between creations to avoid rate limiting
          if (i < itemsArray.length - 1) {
            await new Promise(r => setTimeout(r, 1000));
          }
        } catch (error) {
          log(`❌ Failed to create cache for ${item.name}: ${error.message}`);
          if (error.message.includes("TOKEN_ERROR")) {
            serverStates.set(id, "token_error");
          }
        }
      }
    }
    
    saveCache();
    
    // 4. Start health monitoring
    setInterval(checkStreamHealth, 10000);
    setInterval(monitorPerformance, 15000);
    
    // 5. Start streams with staggered delay
    log(`⏰ Starting ${apiItems.size} streams with staggered delay...`);
    
    const startPromises = [];
    itemsArray.forEach(([id, item], index) => {
      if (streamCache.has(id) && serverStates.get(id) !== "token_error") {
        const delay = CONFIG.initialDelay + (index * 2000); // Stagger by 2 seconds each
        const promise = new Promise(resolve => {
          setTimeout(() => {
            startFFmpeg(item).catch(() => {});
            resolve();
          }, delay);
        });
        startPromises.push(promise);
      }
    });
    
    // Wait for all to be scheduled
    await Promise.all(startPromises);
    
    // 6. Start watcher and other services
    setInterval(watcher, CONFIG.pollInterval);
    setInterval(checkAndRotateOldKeys, 3600000);
    
    telegramBotPolling();
    
    log(`✅ System booted with ${apiItems.size} streams`);
    await tg(`🚀 <b>Stream Manager Started</b>\n\nStreams: ${apiItems.size}\nActive: ${activeStreams.size}\nMax: ${CONFIG.maxActiveStreams}`);
    
  } catch (error) {
    log(`❌ Boot failed: ${error.message}`);
    setTimeout(boot, 30000);
  }
}

/* ================= OTHER FUNCTIONS (keep original but optimized) ================= */

async function fetchApiList() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    
    const r = await fetch(CONFIG.streamsApi, { signal: controller.signal });
    clearTimeout(timeout);
    
    const j = await r.json();
    const map = new Map();
    
    if (j.data && Array.isArray(j.data)) {
      j.data.forEach((streamData) => {
        const id = generateStableId(streamData);
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
    log(`❌ API fetch error: ${error.message}`);
    return new Map();
  }
}

async function synchronizeCacheWithApi() {
  const newApiItems = await fetchApiList();
  
  // Remove orphaned cache
  for (const [cacheId] of streamCache) {
    if (!newApiItems.has(cacheId)) {
      stopFFmpeg(cacheId, true);
      streamCache.delete(cacheId);
    }
  }
  
  // Create new cache entries
  for (const [id, item] of newApiItems) {
    if (!streamCache.has(id)) {
      try {
        const newCache = await createLiveWithTimestamp(item.token, item.name);
        streamCache.set(id, newCache);
      } catch (error) {
        if (error.message.includes("TOKEN_ERROR")) {
          serverStates.set(id, "token_error");
        }
      }
    }
  }
  
  saveCache();
  apiItems = newApiItems;
  
  return { removed: 0, added: 0 };
}

async function watcher() {
  try {
    await synchronizeCacheWithApi();
  } catch (error) {
    log(`❌ Watcher error: ${error.message}`);
  }
}

// Keep other functions (formatUptime, telegramBotPolling, etc.) similar but add optimizations

function formatUptime(uptimeMs) {
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

// Start the system
boot();

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);

async function gracefulShutdown() {
  systemState = "stopping";
  telegramPollingActive = false;
  log("🛑 Shutting down...");

  await tg("🛑 <b>Shutting Down</b>\nStopping all streams");

  // Stop all streams
  for (const [id] of activeStreams) {
    stopFFmpeg(id, true);
  }

  await new Promise(r => setTimeout(r, 3000));
  process.exit(0);
}