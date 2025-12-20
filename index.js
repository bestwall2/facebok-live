import fetch from "node-fetch";
import { spawn } from "child_process";

/* ================= CONFIG ================= */

const USER_ACCESS_TOKEN = "PUT_YOUR_USER_TOKEN";
const PAGE_NAME = "Imran books";
const POST_ID = "113309070355643_1347681650702049";

const RESTART_AFTER = 3.6 * 60 * 60 * 1000; // 3h36m (SAFE)

const STREAMS = [
  { name: "beIN SPORTS", url: "http://dhoomtv.xyz/8zpo3GsVY7/beneficial2concern/274160" },
  { name: "beIN SPORTS News", url: "http://dhoomtv.xyz/8zpo3GsVY7/beneficial2concern/274161" },
  { name: "beIN SPORTS 1", url: "http://dhoomtv.xyz/8zpo3GsVY7/beneficial2concern/274162" },
];

/* ================= GLOBAL STATE ================= */

const STATE = {};
const MPD_DATA = { updated_at: "", servers: [] };

/* ================= HELPERS ================= */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fb(url, options = {}) {
  const res = await fetch(url, options);
  const json = await res.json();
  if (json.error) throw new Error(JSON.stringify(json.error));
  return json;
}

/* ================= FACEBOOK ================= */

async function getPage() {
  const data = await fb(
    `https://graph.facebook.com/v19.0/me/accounts?access_token=${USER_ACCESS_TOKEN}`
  );
  const page = data.data.find((p) => p.name === PAGE_NAME);
  if (!page) throw new Error("Page not found");
  return page;
}

async function createLive(pageId, token, title) {
  const live = await fb(
    `https://graph.facebook.com/v19.0/${pageId}/live_videos?access_token=${token}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "UNPUBLISHED",
        title,
        description: title,
        stream_publish: "false",
        enable_backup_ingest: "true",
      }),
    }
  );

  return {
    id: live.id,
    rtmps: [live.stream_url, ...(live.stream_secondary_urls || [])],
  };
}

async function getMPD(liveId, token) {
  for (let i = 0; i < 12; i++) {
    const data = await fb(
      `https://graph.facebook.com/v19.0/${liveId}?fields=dash_preview_url&access_token=${token}`
    );
    if (data.dash_preview_url) return data.dash_preview_url;
    await sleep(5000);
  }
  return null;
}

async function updatePost(token) {
  MPD_DATA.updated_at = new Date().toISOString();

  let text = "🔴 LIVE SERVERS\n\n";
  MPD_DATA.servers.forEach((s, i) => {
    text += `📡 ${i + 1}. ${s.name}\n${s.mpd}\n\n`;
  });
  text += `🕒 Updated: ${MPD_DATA.updated_at}`;

  await fb(
    `https://graph.facebook.com/v19.0/${POST_ID}?access_token=${token}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
    }
  );
}

/* ================= FFMPEG ================= */

function startFFmpeg(input, rtmps, title) {
  let index = 0;

  const run = () => {
    if (index >= rtmps.length) return;

    console.log(`🚀 FFmpeg → ${title} (${index + 1})`);

    const ff = spawn("ffmpeg", [
      "-re",
      "-i",
      input,
      "-c",
      "copy",
      "-f",
      "flv",
      rtmps[index],
    ]);

    ff.stderr.on("data", () => {}); // silent

    ff.on("exit", () => {
      index++;
      run();
    });

    STATE[title].ffmpeg = ff;
  };

  run();
}

/* ================= STREAM LOOP ================= */

async function startStream(stream, pageId, token) {
  console.log(`🎬 START ${stream.name}`);

  const live = await createLive(pageId, token, stream.name);
  await sleep(3000);

  STATE[stream.name] = {};
  startFFmpeg(stream.url, live.rtmps, stream.name);

  await sleep(8000);
  const mpd = await getMPD(live.id, token);

  if (!mpd) throw new Error("MPD not ready");

  const existing = MPD_DATA.servers.find((s) => s.name === stream.name);
  if (existing) existing.mpd = mpd;
  else MPD_DATA.servers.push({ name: stream.name, mpd });

  await updatePost(token);

  console.log(`✅ LIVE READY: ${stream.name}`);

  setTimeout(() => restartStream(stream, pageId, token), RESTART_AFTER);
}

async function restartStream(stream, pageId, token) {
  console.log(`🔄 RESTART ${stream.name}`);

  try {
    STATE[stream.name]?.ffmpeg?.kill("SIGKILL");
    await sleep(5000);
    await startStream(stream, pageId, token);
  } catch (e) {
    console.error(`❌ Restart failed: ${stream.name}`);
  }
}

/* ================= MAIN ================= */

(async () => {
  try {
    const page = await getPage();

    for (const stream of STREAMS) {
      startStream(stream, page.id, page.access_token);
      await sleep(10000); // anti-rate-limit
    }

    console.log("🔥 ALL STREAMS RUNNING FOREVER");
  } catch (e) {
    console.error("FATAL:", e.message);
  }
})();
