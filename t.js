/******************************************************************
 * FACEBOOK MULTI STREAM MANAGER – ADVANCED
 * - dynamic list watcher
 * - cache stream_url
 * - auto add/remove streams
 * - final dash report
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
};

const CACHE_FILE = "./streams_cache.json";

/* ================= STATE ================= */

let systemState = "running";
let apiItems = new Map(); // current api list
let activeStreams = new Map(); // ffmpeg processes
let streamCache = new Map(); // stream_url cache

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

async function tg(msg) {
  await fetch(
    `https://api.telegram.org/bot${CONFIG.telegram.botToken}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CONFIG.telegram.chatId,
        text: msg,
        parse_mode: "HTML",
      }),
    }
  );
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
  const fields = "stream_url,dash_preview_url";
  for (let i = 0; i < 6; i++) {
    const r = await fetch(
      `https://graph.facebook.com/v24.0/${liveId}?fields=${fields}&access_token=${token}`
    );
    const j = await r.json();
    if (j.stream_url) {
      return {
        stream_url: j.stream_url,
        dash: j.dash_preview_url || "N/A",
      };
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("Preview not ready");
}

/* ================= FFMPEG ================= */

function startFFmpeg(item) {
  const cache = streamCache.get(item.id);
  if (!cache) return;

  log(`▶ START ${item.name}`);

  const cmd = ffmpeg(item.source)
    .inputOptions(["-re"])
    .outputOptions(["-c", "copy", "-f", "flv"])
    .output(cache.stream_url)
    .on("error", () => restartFFmpeg(item))
    .on("end", () => restartFFmpeg(item));

  activeStreams.set(item.id, cmd);
  cmd.run();
}

function stopFFmpeg(id) {
  try {
    activeStreams.get(id)?.kill("SIGKILL");
  } catch {}
  activeStreams.delete(id);
}

function restartFFmpeg(item) {
  if (systemState !== "running") return;
  stopFFmpeg(item.id);
  setTimeout(() => startFFmpeg(item), 60000);
}

/* ================= API WATCHER ================= */

async function fetchApiList() {
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
}

async function watcher() {
  const newList = await fetchApiList();

  /* ➕ NEW ITEMS */
  for (const [id, item] of newList) {
    if (!apiItems.has(id)) {
      log(`➕ NEW ITEM ${item.name}`);
      const liveId = await createLive(item.token, item.name);
      const preview = await getStreamAndDash(liveId, item.token);
      streamCache.set(id, { liveId, ...preview });
      saveCache();

      setTimeout(() => startFFmpeg(item), 120000); // wait 2 min
    }
  }

  /* ❌ REMOVED ITEMS */
  for (const [id] of apiItems) {
    if (!newList.has(id)) {
      log(`❌ REMOVED ITEM ${id}`);
      stopFFmpeg(id);
      streamCache.delete(id);
      saveCache();
    }
  }

  apiItems = newList;
}

/* ================= FINAL CHECK ================= */

async function finalCheckReport() {
  if (activeStreams.size === 0) return;

  const lines = [];
  streamCache.forEach((v, id) => {
    lines.push(`<b>${id}</b>\nDASH: ${v.dash}`);
  });

  await tg(`📡 <b>DASH REPORT</b>\n\n${lines.join("\n\n")}`);
}

/* ================= BOOT ================= */

async function boot() {
  loadCache();
  apiItems = await fetchApiList();

  for (const item of apiItems.values()) {
    if (!streamCache.has(item.id)) {
      const liveId = await createLive(item.token, item.name);
      const preview = await getStreamAndDash(liveId, item.token);
      streamCache.set(item.id, { liveId, ...preview });
      saveCache();
      setTimeout(() => startFFmpeg(item), 120000);
    } else {
      startFFmpeg(item);
    }
  }

  setInterval(watcher, CONFIG.pollInterval);
  setTimeout(finalCheckReport, 180000);
}

boot();

/* ================= SHUTDOWN ================= */

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
