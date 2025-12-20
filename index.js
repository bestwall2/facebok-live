import fetch from "node-fetch";
import { spawn } from "child_process";

/* ================== CONFIG ================== */

const USER_ACCESS_TOKEN =
  "EAATr298atI4BQBRhuLHxHyjcAmdX4LtxSov0gcLExE3trQvbIZC5NnOaHbzOFNYBhRUL62P4lTMBefezx8XyNHzbT2FANjJothFJh4VizZAaI5dm5bQHTdAkZCspReYWBZCWd7CLtu4ovsT3jZAHp3bksXCmxIvtwUcZCVDVTnbF6C13fGIsSkJrp1V4SsSNJksktZAJneeqqd21Jp0MEFm7JZC2wpU4ktFS4k1Mt7EtIl2p";

const POST_TOKEN =
  "EAAKXMxkBFCIBQE9RYVPdKqCT697AtGFZC0fwy99hy3ZCK3lhT1Cb5hFIViJZC8tAKIDL4QzOtVPpEqG7LhDKc8cqF1MdBCi9mfZCMYHOZAPsVZAG99JKnm8lSOg6LFXylgKGSi2LSPOoZBTZAOgVfTSuYAbzl38NDmz6GUrp1B1K2gV6TGqSNOQC5LDZB6hhvGJvm7oZBr3BBlb42OVmDXpm6eG0wKU421xY1bx64NURpoHU6120XsZA5BOVgZDZD";

const PAGE_NAME = "Page Test";
const POST_ID = "113309070355643_1347681650702049";

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

/* ================== PAGE TOKEN ================== */

async function getPageToken() {
  const data = await fetchJSON(
    `https://graph.facebook.com/v19.0/me/accounts?access_token=${USER_ACCESS_TOKEN}`
  );
  const page = data.data.find((p) => p.name === PAGE_NAME);
  if (!page) throw new Error("Page not found");
  return { id: page.id, token: page.access_token };
}

/* ================== CREATE LIVE ================== */

async function createLive(pageId, pageToken, title) {
  const data = await fetchJSON(
    `https://graph.facebook.com/v19.0/${pageId}/live_videos?access_token=${pageToken}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "UNPUBLISHED",
        title,
        description: title,
        
      }),
    }
  );

  return { id: data.id, rtmp: data.stream_url };
}

/* ================== FFMPEG SUPERVISED ================== */

function startFFmpeg(input, rtmp, title) {
  let attempts = 0;

  const args = [
    "-re",
    "-i",
    input,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-profile:v",
    "high",
    "-level",
    "4.1",
    "-pix_fmt",
    "yuv420p",
    "-r",
    "25",
    "-g",
    "50",
    "-keyint_min",
    "50",
    "-sc_threshold",
    "0",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ar",
    "44100",
    "-f",
    "flv",
    rtmp,
  ];

  const run = () => {
    attempts++;
    console.log(`🎬 [${title}] FFmpeg start (attempt ${attempts})`);

    const ff = spawn("ffmpeg", args);

    ff.stderr.on("data", (d) => {
      const msg = d.toString();
      if (msg.includes("Error") || msg.includes("failed")) {
        console.log(`[FFmpeg ${title}] ${msg}`);
      }
    });

    ff.on("exit", (code) => {
      if (code !== 0 && attempts < 5) {
        console.log(`🔁 [${title}] Restarting in 15s`);
        setTimeout(run, 15000);
      }
    });
  };

  run();
}

/* ================== GET MPD ================== */

async function getMPD(liveId, token) {
  for (let i = 0; i < 20; i++) {
    const data = await fetchJSON(
      `https://graph.facebook.com/v19.0/${liveId}?fields=dash_preview_url&access_token=${token}`
    );
    if (data.dash_preview_url) return data.dash_preview_url;
    await sleep(5000);
  }
  return null;
}

/* ================== UPDATE POST ================== */

async function editPost(token, text) {
  await fetchJSON(
    `https://graph.facebook.com/v19.0/${POST_ID}?access_token=${token}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
    }
  );
}

function formatPost(servers) {
  let text = "🔴 LIVE SERVERS\n\n";
  servers.forEach((s, i) => {
    text += `📡 ${i + 1}. ${s.name}\n${s.mpd}\n\n`;
  });
  text += `🕒 Updated: ${new Date().toLocaleTimeString()}`;
  return text;
}

/* ================== MAIN QUEUE ================== */

(async () => {
  try {
    const { id: pageId, token } = await getPageToken();
    const results = [];

    for (const stream of STREAMS) {
      console.log(`🚀 Starting ${stream.name}`);

      const live = await createLive(pageId, token, stream.name);

      await sleep(15000); // IMPORTANT
      startFFmpeg(stream.url, live.rtmp, stream.name);

      await sleep(25000); // Facebook processing time
      const mpd = await getMPD(live.id, token);

      if (mpd) {
        results.push({ name: stream.name, mpd });
        console.log(`✅ MPD ready for ${stream.name}`);
      }

      console.log("⏳ Waiting before next stream...");
      await sleep(30000); // CRITICAL DELAY
    }

    if (results.length) {
      await editPost(POST_TOKEN, formatPost(results));
      console.log("✅ Facebook post updated");
    }
  } catch (e) {
    console.error("FATAL:", e.message);
  }
})();
