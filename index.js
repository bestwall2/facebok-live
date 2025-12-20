import fetch from "node-fetch";
import { spawn } from "child_process";

/* ================== CONFIG ================== */
const USER_ACCESS_TOKEN =
  "EAAKXMxkBFCIBQN8ZCGkQZB1qgo2zzX80bbthq2n0WY25koXwRrtu29B16FDchK7u8lZCb9W1FM6XCgVj4Vl8f0yn1NOjR9zZAtfRKZCdGiY9xJcoerBTLUXGpTZCHufGGB5Ysky2U362ISLmVZA0WkcwFZBWHri7LACajXyREchxsXDYX84qNvSOx6J4iVfeH7lpvcKcXxIZCZCZB2WiT5PHLGx3M1sZCO9T7Uo0KcLgz3bqZAQZDZD";

const PAGE_NAME = "Imran books";
const POST_ID = "113309070355643_1347681650702049";

const STREAMS = [
  { name: "beIN SPORTS", url: "http://dhoomtv.xyz/8zpo3GsVY7/beneficial2concern/274160" },
  { name: "beIN SPORTS News", url: "http://dhoomtv.xyz/8zpo3GsVY7/beneficial2concern/274161" },
  { name: "beIN SPORTS 1", url: "http://dhoomtv.xyz/8zpo3GsVY7/beneficial2concern/274162" },
];

/* ================== HELPERS ================== */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchJSON(url, options = {}) {
  const res = await fetch(url, options);
  const json = await res.json();
  if (json.error) throw new Error(JSON.stringify(json.error));
  return json;
}

/* ================== 1. GET PAGE TOKEN ================== */
async function getPageToken() {
  const data = await fetchJSON(
    `https://graph.facebook.com/v19.0/me/accounts?access_token=${USER_ACCESS_TOKEN}`
  );
  const page = data.data.find(p => p.name === PAGE_NAME);
  if (!page) throw new Error("Page not found");
  return { pageId: page.id, pageToken: page.access_token };
}

/* ================== 2. CREATE LIVES ================== */
async function createAllLives(pageId, pageToken) {
  const lives = [];

  for (const stream of STREAMS) {
    const data = await fetchJSON(
      `https://graph.facebook.com/v19.0/${pageId}/live_videos?access_token=${pageToken}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "UNPUBLISHED",
          title: stream.name,
          description: stream.name,
          stream_publish: "false",
          enable_backup_ingest: "true",
        }),
      }
    );

    lives.push({
      name: stream.name,
      input: stream.url,
      liveId: data.id,
      rtmp: data.stream_url,
    });

    console.log(`✅ RTMP ready for ${stream.name}`);
    await sleep(1500); // Slight delay between live creations
  }

  return lives;
}

/* ================== 3. START FFMPEG ================== */
async function startAllFFmpeg(lives) {
  for (const live of lives) {
    console.log(`🚀 Starting FFmpeg → ${live.name}`);

    const ffmpeg = spawn("ffmpeg", [
      "-re",
      "-i", live.input,
      "-c", "copy",
      "-f", "flv",
      "-reconnect", "1",
      "-reconnect_streamed", "1",
      "-reconnect_delay_max", "2",
      live.rtmp,
    ]);

    ffmpeg.stderr.on("data", (d) => console.log(`[FFmpeg ${live.name}] ${d.toString()}`));
    ffmpeg.on("exit", (code) => console.log(`[FFmpeg ${live.name}] exited with code ${code}`));

    // Wait 2 minutes after starting each stream (optional)
    console.log(`🕒 Waiting 2 minutes after starting ${live.name}...`);
    await sleep(10000);
  }
}

/* ================== 4. GET MPDs ================== */
async function getAllMPDs(lives, pageToken) {
  const servers = [];

  for (const live of lives) {
    let mpd = null;

    for (let i = 0; i < 12; i++) {
      const data = await fetchJSON(
        `https://graph.facebook.com/v19.0/${live.liveId}?fields=dash_preview_url&access_token=${pageToken}`
      );

      if (data.dash_preview_url) {
        mpd = data.dash_preview_url;
        break;
      }

      await sleep(5000); // Retry every 5s
    }

    if (mpd) {
      servers.push({ name: live.name, mpd });
      console.log(`🎯 MPD ready for ${live.name}`);
    } else {
      console.warn(`⚠️ MPD timeout for ${live.name}`);
    }
  }

  return servers;
}

/* ================== 5. UPDATE POST ================== */
async function updatePost(pageToken, servers) {
  let text = "🔴 LIVE SERVERS\n\n";
  servers.forEach((s, i) => {
    text += `📡 ${i + 1}. ${s.name}\n${s.mpd}\n\n`;
  });

  await fetchJSON(
    `https://graph.facebook.com/v19.0/${POST_ID}?access_token=${pageToken}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
    }
  );

  console.log("✅ Post updated");
}

/* ================== 6. MAIN ================== */
(async () => {
  try {
    const { pageId, pageToken } = await getPageToken();

    console.log("🟡 STEP 1 → Creating lives");
    const lives = await createAllLives(pageId, pageToken);

    console.log("🟡 STEP 2 → Starting FFmpeg");
    await startAllFFmpeg(lives);

    console.log("🟡 STEP 3 → Extracting MPDs");
    const servers = await getAllMPDs(lives, pageToken);

    if (servers.length) {
      console.log("🟡 STEP 4 → Updating post");
      await updatePost(pageToken, servers);
    }

    console.log("🎉 DONE: All streams started and post updated");

  } catch (e) {
    console.error("❌ ERROR:", e.message);
  }
})();

