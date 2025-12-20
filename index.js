import fetch from "node-fetch";
import { spawn } from "child_process";

/* ================== CONFIG ================== */
const USER_ACCESS_TOKEN = "EAAKXMxkBFCIBQLNxhcHEE3nI7bm9gHpJsoFBeQ8ZCtoUeEtTZBNkgmiYhDFBhsIYfPvzI4aUZC3SZAwHSb3jh09lncfAFkSWgfnFKbYUmwSkXctMIrK7JYEBvWUbOkZBjU3dZCG0Yds2KYDxAWDxe3YIbw4FZAwZCKJgQFZBog8PZAGolhkIZCp5dEZCbS9C8XM0LZCR7vsZBTlvk0n0MbCHEtwf3SzuQxa3QvrLKoHc4e";
const PAGE_NAME = "Imran books";
const POST_ID = "113309070355643_1347681650702049"; 

/* ===== STREAM LIST ===== */
const STREAMS = [
  { name: "beIN SPORTS", url: "http://dhoomtv.xyz/8zpo3GsVY7/beneficial2concern/274160" },
  { name: "beIN SPORTS News", url: "http://dhoomtv.xyz/8zpo3GsVY7/beneficial2concern/274161" },
  { name: "beIN SPORTS 1", url: "http://dhoomtv.xyz/8zpo3GsVY7/beneficial2concern/274162" },
];

/* ================== HELPERS ================== */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJSON(url, options) {
  const res = await fetch(url, options);
  const data = await res.json();
  if (data.error) throw new Error(JSON.stringify(data.error));
  return data;
}

/* ================== 1. PAGE TOKEN ================== */
async function getPageToken() {
  const data = await fetchJSON(`https://graph.facebook.com/v19.0/me/accounts?access_token=${USER_ACCESS_TOKEN}`);
  const page = data.data.find((p) => p.name === PAGE_NAME);
  if (!page) throw new Error("Page not found or no admin access");
  console.log("✅ Page token ready");
  return { id: page.id, token: page.access_token };
}

/* ================== 2. CREATE LIVE ================== */
async function createLive(pageId, pageToken, title) {
  const data = await fetchJSON(`https://graph.facebook.com/v19.0/${pageId}/live_videos?access_token=${pageToken}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      status: "UNPUBLISHED",
      title,
      description: title,
      stream_publish: "false",
      enable_backup_ingest: "true",
    }),
  });

  const rtmpUrls = [data.stream_url, ...(data.stream_secondary_urls || [])];
  console.log(`🎥 Live created: ${title}`);
  return { id: data.id, rtmpUrls };
}

/* ================== 3. START FFMPEG ================== */
function startFFmpegCopy(input, rtmpUrls, title) {
  let index = 0;

  const run = () => {
    if (index >= rtmpUrls.length) {
      console.error(`❌ All RTMPS failed for ${title}`);
      return;
    }

    console.log(`🚀 Starting FFmpeg for: ${title}`);
    // Added -re to ensure stream reads at native frame rate
    const ffmpeg = spawn("ffmpeg", ["-re", "-i", input, "-c", "copy", "-f", "flv", rtmpUrls[index]]);

    ffmpeg.stderr.on("data", (data) => {
        // Optional: reduce console noise by only logging errors
        const msg = data.toString();
        if(msg.includes("error") || msg.includes("failed")) console.log(`[FFmpeg ${title}] ${msg}`);
    });

    ffmpeg.on("close", (code) => {
      if (code !== 0) {
        console.warn(`⚠️ FFmpeg failed for ${title}, switching to next backup in 5s...`);
        setTimeout(() => {
            index++;
            run();
        }, 5000);
      }
    });
  };

  run();
}

/* ================== 4. GET MPD URL ================== */
async function getLiveMPD(liveId, pageToken) {
  for (let i = 0; i < 15; i++) { // Increased retries
    const data = await fetchJSON(`https://graph.facebook.com/v19.0/${liveId}?fields=dash_preview_url&access_token=${pageToken}`);
    if (data.dash_preview_url) return data.dash_preview_url;
    await sleep(5000);
  }
  return null;
}

/* ================== 5. EDIT POST ================== */
async function editPost(pageToken, content) {
  await fetchJSON(`https://graph.facebook.com/v19.0/${POST_ID}?access_token=${pageToken}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: content }),
  });
}

/* ================== 6. FORMAT POST ================== */
function formatPost(json) {
  let text = "🔴 LIVE SERVERS\n\n";
  json.servers.forEach((s, i) => {
    text += `📡 ${i + 1}. ${s.name}\n${s.mpd}\n\n`;
  });
  text += `🕒 Last Updated: ${new Date().toLocaleTimeString()}`;
  return text;
}

/* ================== 7. MAIN ================== */
(async () => {
  try {
    const { id: pageId, token } = await getPageToken();
    const mpdData = { servers: [] };

    console.log(`🚀 Starting initialization for ${STREAMS.length} streams...`);

    // We use a regular loop instead of Promise.all to add time between requests
    for (const stream of STREAMS) {
      try {
        console.log(`--- Processing: ${stream.name} ---`);
        const live = await createLive(pageId, token, stream.name);
        
        // Wait 3 seconds before starting FFmpeg to ensure FB ingest is ready
        await sleep(3000);
        startFFmpegCopy(stream.url, live.rtmpUrls, stream.name);

        // Wait 10 seconds for the stream to process on FB before asking for MPD
        await sleep(10000); 
        const mpd = await getLiveMPD(live.id, token);
        
        if (mpd) {
          mpdData.servers.push({ name: stream.name, live_id: live.id, mpd });
          console.log(`✅ MPD Obtained for ${stream.name}`);
        }

        // Delay between starting different streams to avoid API flooding
        console.log(`Waiting 3 seconds before next stream...`);
        await sleep(3000);

      } catch (err) {
        console.error(`❌ Stream failed: ${stream.name}`, err.message);
      }
    }

    if (mpdData.servers.length > 0) {
      const postText = formatPost(mpdData);
      await editPost(token, postText);
      console.log("✅ Post updated successfully");
    }

  } catch (err) {
    console.error("FATAL ERROR:", err.message);
  }
})();
