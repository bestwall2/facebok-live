import fetch from "node-fetch";
import { spawn } from "child_process";

/* ================== CONFIG ================== */
const USER_ACCESS_TOKEN =
  "EAAKXMxkBFCIBQNc3VmXSmqPTmUWBrhsyQpPaJCliX9DXHgxVTK4Jlh7nnmQ6MQxoYWbPWlAV8ZBecwBz8oEzS8cosZCcGH6Os2X4zg4HQIZAjlE2iFwBeJPc6FziLdYk5LiMJr3JV0WMZAyGd3BlrsWMTzZAN9HsZCL636TvmsDThECYEOhHAeqkOnKWc8fYSJjm89MX5G4wRZC3rZAHBPjtXKmxU5ZAzQR6mjxwJv0cZClDi9EugVtEpNC5gNj5xwG5gFi5dGWeXrTnXOQ0l94ZBzPdj5hKMl13okZD";
const PAGE_NAME = "Imran books";
const POST_ID = "113309070355643_1347681650702049"; // The post to update

/* ===== STREAM LIST ===== */
const STREAMS = [
  {
    name: "beIN SPORTS",
    url: "http://dhoomtv.xyz/8zpo3GsVY7/beneficial2concern/274160",
  },
  {
    name: "beIN SPORTS News",
    url: "http://dhoomtv.xyz/8zpo3GsVY7/beneficial2concern/274161",
  },
  {
    name: "beIN SPORTS 1",
    url: "http://dhoomtv.xyz/8zpo3GsVY7/beneficial2concern/274162",
  },
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
  const res = await fetch(
    `https://graph.facebook.com/v19.0/me/accounts?access_token=${USER_ACCESS_TOKEN}`
  );
  const data = await res.json();
  if (data.error) throw new Error(JSON.stringify(data.error));

  const page = data.data.find((p) => p.name === PAGE_NAME);
  if (!page) throw new Error("Page not found or no admin access");

  console.log("✅ Page token ready");
  return { id: page.id, token: page.access_token };
}

/* ================== 2. CREATE LIVE ================== */
async function createLive(pageId, pageToken, title) {
  const res = await fetch(
    `https://graph.facebook.com/v19.0/${pageId}/live_videos?access_token=${pageToken}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "UNPUBLISHED", // private live
        title: title,
        description: title,
        stream_publish: "false",
        enable_backup_ingest: "true",
      }),
    }
  );

  const data = await res.json();
  if (data.error) throw new Error(JSON.stringify(data.error));

  // Include backup URLs if available
  const rtmpUrls = [data.stream_url, ...(data.stream_secondary_urls || [])];

  console.log(`🎥 Live created: ${title}`);
  return { id: data.id, rtmpUrls };
}

/* ================== 3. START FFMPEG WITH BACKUP ================== */
function startFFmpegCopy(input, rtmpUrls, title) {
  let index = 0;

  const run = () => {
    if (index >= rtmpUrls.length) {
      console.error(`❌ All RTMPS failed for ${title}`);
      return;
    }

    console.log(`🚀 Starting FFmpeg for: ${title} (URL ${index + 1})`);
    const ffmpeg = spawn(
      "ffmpeg",
      ["-re", "-i", input, "-c", "copy", "-f", "flv", rtmpUrls[index]]
      //{ stdio: "ignore" } // suppress logs if desired
    );

    ffmpeg.on("close", (code) => {
      if (code !== 0) {
        console.warn(
          `⚠️ FFmpeg failed for ${title} on URL ${
            index + 1
          }, switching to next backup`
        );
        index++;
        run();
      }
    });
  };

  run();
}

/* ================== 4. GET MPD URL ================== */
async function getLiveMPD(liveId, pageToken) {
  for (let i = 0; i < 12; i++) {
    const res = await fetch(
      `https://graph.facebook.com/v19.0/${liveId}?fields=dash_preview_url&access_token=${pageToken}`
    );
    const data = await res.json();
    if (data.dash_preview_url) return data.dash_preview_url;
    await sleep(5000);
  }
  return null;
}

/* ================== 5. EDIT POST ================== */
async function editPost(pageToken, content) {
  const res = await fetch(
    `https://graph.facebook.com/v19.0/${POST_ID}?access_token=${pageToken}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: content }),
    }
  );
  const data = await res.json();
  if (data.error) throw new Error(JSON.stringify(data.error));
}

/* ================== 6. FORMAT POST ================== */
function formatPost(json) {
  let text = "🔴 LIVE SERVERS\n\n";
  json.servers.forEach((s, i) => {
    text += `📡 ${i + 1}. ${s.name}\n`;
    text += `${s.mpd}\n\n`;
  });
  text += `🕒 Updated: ${json.updated_at}`;
  return text;
}

/* ================== 7. MAIN ================== */
(async () => {
  try {
    const { id: pageId, token } = await getPageToken();

    const mpdData = { updated_at: new Date().toISOString(), servers: [] };

    for (const stream of STREAMS) {
      try {
        const live = await createLive(pageId, token, stream.name);
        await sleep(2000);

        startFFmpegCopy(stream.url, live.rtmpUrls, stream.name);

        await sleep(8000); // Wait for live to become active
        const mpd = await getLiveMPD(live.id, token);
        if (mpd) {
          mpdData.servers.push({ name: stream.name, live_id: live.id, mpd });
        } else {
          console.warn(`⚠️ MPD not ready for ${stream.name}`);
        }

        await sleep(500); // slight delay between streams
      } catch (err) {
        console.error(`❌ Stream failed: ${stream.name}`, err.message);
      }
    }

    if (mpdData.servers.length > 0) {
      const postText = formatPost(mpdData);
      await editPost(token, postText);
      console.log("✅ Post updated with all MPD URLs");
    }

    console.log("✅ All lives launched");
  } catch (err) {
    console.error("ERROR:", err.message);
  }
})();
