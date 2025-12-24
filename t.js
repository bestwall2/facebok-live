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
 * - Stable stream IDs
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
  initialDelay: 110000, // 1:50 minutes for ALL servers initial start
  newServerDelay: 30000, // 30 seconds for NEW servers
  crashedServerDelay: 120000, // 2 minutes
  rotationInterval: 13500000, // 3:45 hours
};

const CACHE_FILE = "./streams_cache.json";

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

/* ================= CACHE ================= */
function loadCache() {
  if (!fs.existsSync(CACHE_FILE)) return log("📝 No cache file found, starting fresh");
  try {
    const data = fs.readFileSync(CACHE_FILE, "utf8");
    if (!data.trim()) return log("📝 Cache file is empty, starting fresh");
    const json = JSON.parse(data);
    Object.entries(json).forEach(([k, v]) => streamCache.set(k, v));
    log(`✅ Loaded ${streamCache.size} cached streams from file`);
  } catch (error) {
    log(`❌ Error loading cache: ${error.message}`);
    try {
      const backupName = `${CACHE_FILE}.corrupted.${Date.now()}`;
      fs.renameSync(CACHE_FILE, backupName);
      log(`⚠️ Corrupted cache backed up to: ${backupName}`);
    } catch {}
    streamCache.clear();
  }
}

function saveCache() {
  try {
    const o = {};
    streamCache.forEach((v, k) => (o[k] = v));
    fs.writeFileSync(CACHE_FILE, JSON.stringify(o, null, 2));
    log(`💾 Cache saved with ${streamCache.size} streams`);
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
    if (!result.ok) log(`❌ Telegram error: ${result.description}`);
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
    body: JSON.stringify({ title: name, status: "UNPUBLISHED", access_token: token }),
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
  for (let i = 0; i < 15; i++) {
    try {
      const r = await fetch(`https://graph.facebook.com/v24.0/${liveId}?fields=${fields}&access_token=${token}`);
      if (!r.ok) { await new Promise(r => setTimeout(r, 2000)); continue; }
      const j = await r.json();
      if (j.stream_url) return { stream_url: j.stream_url, dash: j.dash_preview_url || "N/A", status: j.status || "UNKNOWN" };
      await new Promise(r => setTimeout(r, 2000));
    } catch { await new Promise(r => setTimeout(r, 2000)); }
  }
  throw new Error("Preview not ready after 30 seconds");
}

/* ================= STABLE STREAM ID ================= */
function generateStreamId(name, source) {
  const str = `${name.trim()}|${source.trim()}`;
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = (hash << 5) - hash + str.charCodeAt(i) & hash;
  return `stream_${Math.abs(hash).toString(16).substring(0, 8)}`;
}

/* ================= FFMPEG ================= */
function startFFmpeg(item) {
  const cache = streamCache.get(item.id);
  if (!cache) return log(`❌ No cache for ${item.name}, cannot start`);
  if (["starting", "restarting"].includes(serverStates.get(item.id))) return log(`⚠️ ${item.name} already starting/restarting`);

  log(`▶ STARTING ${item.name} (ID: ${item.id})`);
  serverStates.set(item.id, "starting");

  if (restartTimers.has(item.id)) { clearTimeout(restartTimers.get(item.id)); restartTimers.delete(item.id); }

  const cmd = ffmpeg(item.source)
    .inputOptions(["-re", "-y"])
    .videoCodec("libx264")
    .audioCodec("copy")
    .outputOptions([
      "-ac", "1",
      "-ar", "44100",
      "-b:a", "96k",
      "-pix_fmt", "yuv420p",
      "-tune", "zerolatency",
      "-preset", "veryfast",
      "-maxrate", "2000k",
      "-f", "flv",
      "-flvflags", "no_duration_filesize",
      "-avoid_negative_ts", "make_zero",
      "-muxdelay", "0",
      "-muxpreload", "0"
    ])
    .output(cache.stream_url)
    .on("start", () => { 
      log(`✅ FFmpeg started for ${item.name}`); 
      streamStartTimes.set(item.id, Date.now()); 
      serverStates.set(item.id, "running"); 
      startRotationTimer(item);
    })
    .on("error", err => handleStreamCrash(item, err.message))
    .on("end", () => handleStreamCrash(item, "Stream ended unexpectedly"));

  activeStreams.set(item.id, cmd);
  cmd.run();
}

function handleStreamCrash(item, reason) {
  const state = serverStates.get(item.id);
  if (state === "rotating") return log(`🔄 ${item.name} crashed during rotation`);

  const uptime = streamStartTimes.has(item.id) ? formatUptime(Date.now() - streamStartTimes.get(item.id)) : "Unknown";
  tg(`🔴 <b>SERVER CRASH REPORT</b>\n\n<b>${item.name}</b>\nID: ${item.id}\nReason: ${reason}\nUptime: ${uptime}\nStatus: Will restart in 2 minutes`);
  log(`🔄 ${item.name} (ID: ${item.id}) will restart in 2 minutes`);

  serverStates.set(item.id, "restarting");
  stopFFmpeg(item.id);

  const restartTimer = setTimeout(() => {
    if (systemState === "running" && serverStates.get(item.id) === "restarting") startFFmpeg(item);
  }, CONFIG.crashedServerDelay);
  restartTimers.set(item.id, restartTimer);
}

function stopFFmpeg(id, skipReport = false) {
  try {
    const proc = activeStreams.get(id);
    if (proc) {
      proc.kill("SIGTERM");
      setTimeout(() => { try { proc.kill("SIGKILL") } catch {} }, 5000);
    }
  } catch (err) { log(`❌ Error stopping ${id}: ${err.message}`); }
  activeStreams.delete(id);
  streamStartTimes.delete(id);
}

/* ================= ROTATION SYSTEM ================= */
function startRotationTimer(item) {
  if (streamRotationTimers.has(item.id)) clearTimeout(streamRotationTimers.get(item.id));
  log(`⏰ Rotation timer started for ${item.name} - 3:45 hours`);
  const rotationTimer = setTimeout(() => rotateStreamKey(item), CONFIG.rotationInterval);
  streamRotationTimers.set(item.id, rotationTimer);
}

async function rotateStreamKey(item) {
  try {
    serverStates.set(item.id, "rotating");
    stopFFmpeg(item.id, true);
    streamCache.delete(item.id); saveCache();
    const liveId = await createLive(item.token, item.name);
    const preview = await getStreamAndDash(liveId, item.token);
    streamCache.set(item.id, { liveId, ...preview }); saveCache();
    await tg(`🔄 <b>STREAM KEY ROTATED</b>\n<b>${item.name}</b>\nID: ${item.id}\nDASH: <code>${preview.dash}</code>\nStatus: Will start in 30s`);
    serverStates.set(item.id, "starting");
    setTimeout(() => { if (systemState === "running") startFFmpeg(item); }, CONFIG.newServerDelay);
  } catch (error) {
    log(`❌ Rotation failed for ${item.name}: ${error.message}`);
    serverStates.set(item.id, "failed");
    setTimeout(() => { if (systemState === "running") rotateStreamKey(item); }, 300000);
  }
}

/* ================= UPTIME ================= */
function formatUptime(ms) {
  if (!ms || ms < 0) return "Not active";
  const s = Math.floor(ms / 1000 % 60), m = Math.floor(ms / 60000 % 60), h = Math.floor(ms / 3600000 % 24), d = Math.floor(ms / 86400000);
  const parts = []; if (d) parts.push(d + "d"); if (h) parts.push(h + "h"); if (m) parts.push(m + "m"); if (s || parts.length === 0) parts.push(s + "s"); return parts.join(" ");
}

/* ================= SERVER INFO ================= */
function getServerInfo() {
  return {
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    uptime: formatUptime(process.uptime() * 1000),
    memory: { used: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`, total: `${Math.round(os.totalmem() / 1024 / 1024)}MB` },
    streams: { active: activeStreams.size, total: apiItems.size, cached: streamCache.size },
    time: new Date().toLocaleString(),
    initialDelay: `${CONFIG.initialDelay / 1000}s`,
    newServerDelay: `${CONFIG.newServerDelay / 1000}s`,
    crashedServerDelay: `${CONFIG.crashedServerDelay / 1000}s`,
    rotationInterval: `${CONFIG.rotationInterval / 3600000}h`
  };
}

/* ================= API WATCHER ================= */
async function fetchApiList() {
  try {
    const r = await fetch(CONFIG.streamsApi);
    const j = await r.json();
    const map = new Map();
    j.data.forEach(s => {
      const cleanName = s.name?.trim() || "Unnamed Stream";
      const cleanSource = s.source?.trim() || "";
      const cleanToken = s.token?.trim() || "";
      map.set(generateStreamId(cleanName, cleanSource), { id: generateStreamId(cleanName, cleanSource), name: cleanName, token: cleanToken, source: cleanSource });
    });
    return map;
  } catch { return apiItems; }
}

async function watcher() {
  try {
    const newList = await fetchApiList();
    for (const [id, item] of newList) {
      if (!apiItems.has(id)) {
        const liveId = await createLive(item.token, item.name);
        const preview = await getStreamAndDash(liveId, item.token);
        streamCache.set(id, { liveId, ...preview }); saveCache();
        serverStates.set(id, "starting");
        setTimeout(() => startFFmpeg(item), CONFIG.newServerDelay);
      }
    }
    for (const [id, oldItem] of apiItems) if (!newList.has(id)) { stopFFmpeg(id,true); streamCache.delete(id); saveCache(); serverStates.delete(id); }
    apiItems = newList;
  } catch {}
}

/* ================= TELEGRAM BOT ================= */
let lastCommandTime = new Map();
async function handleTelegramCommand(update) {
  const message = update.message;
  if (!message?.text) return;
  const chatId = message.chat.id;
  const userId = message.from.id;
  const command = message.text.trim();
  const now = Date.now();
  if (lastCommandTime.has(userId) && now - lastCommandTime.get(userId) < 5000) { await tg("⏳ Wait 5 seconds", chatId); return; }
  lastCommandTime.set(userId, now);
  if (command.startsWith("/info")) { await tg(await generateInfoReport(), chatId); return; }
  if (command.startsWith("/status")) { await tg(`📊 Active: ${activeStreams.size}\nTotal: ${apiItems.size}`, chatId); return; }
  if (command.startsWith("/help")) { await tg(`🤖 /info /status /help`, chatId); return; }
}

async function telegramBotPolling() {
  let offset = 0;
  while (systemState === "running") {
    try {
      const response = await fetch(`https://api.telegram.org/bot${CONFIG.telegram.botToken}/getUpdates?offset=${offset}&timeout=30`);
      const data = await response.json();
      if (data.ok && data.result.length > 0) for (const update of data.result) { offset = update.update_id + 1; await handleTelegramCommand(update); }
    } catch { await new Promise(r => setTimeout(r, 5000)); }
    await new Promise(r => setTimeout(r, 1000));
  }
}

/* ================= FINAL CHECK ================= */
async function finalCheckReport() {
  if (activeStreams.size === 0) await tg("⚠️ No active streams detected");
  else {
    const lines = [];
    streamCache.forEach((v,id) => { const item=apiItems.get(id); const state=serverStates.get(id); const start=streamStartTimes.get(id); lines.push(`<b>${item?.name||id}</b>\nID:${id}\nStatus:${state||"unknown"}\nDASH:<code>${v.dash}</code>\nUptime:${formatUptime(start?Date.now()-start:0)}`); });
    await tg(`📡 <b>DASH REPORT</b>\n\n${lines.join("\n\n")}`);
  }
}

/* ================= BOOT ================= */
async function boot() {
  log("🚀 Booting Stream Manager...");
  loadCache();
  apiItems = await fetchApiList();
  await tg(`🚀 <b>Stream Manager Started</b>\nTotal items: ${apiItems.size}\nCached streams: ${streamCache.size}`);
  for (const item of apiItems.values()) if (!streamCache.has(item.id)) { const liveId = await createLive(item.token,item.name); const preview=await getStreamAndDash(liveId,item.token); streamCache.set(item.id,{liveId,...preview}); saveCache(); }
  startupTimer=setTimeout(()=>{ for(const item of apiItems.values()) startFFmpeg(item); setInterval(watcher, CONFIG.pollInterval); setTimeout(finalCheckReport,300000); }, CONFIG.initialDelay);
  telegramBotPolling();
}
boot();

/* ================= SHUTDOWN ================= */
async function gracefulShutdown() {
  systemState="stopping";
  if (startupTimer) clearTimeout(startupTimer);
  for(const [id] of activeStreams) stopFFmpeg(id,true);
  restartTimers.forEach(t=>clearTimeout(t));
  streamRotationTimers.forEach(t=>clearTimeout(t));
  await new Promise(r=>setTimeout(r,2000));
  process.exit(0);
}
process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);
