/******************************************************************
 * FACEBOOK MULTI STREAM MANAGER – CONTROL MODE
 * - START / STOP / RESTART via Supabase REST API
 * - Streams use dynamically fetched RTMPS URL from Facebook
 * - Extract DASH (MPD) preview URL and RTMPS stream URL after ffmpeg starts successfully
 * - Send per-stream preview report to Telegram (channel + DASH preview + RTMPS URL)
 ******************************************************************/

import fs from "fs";
import ffmpeg from "fluent-ffmpeg";
import fetch from "node-fetch"; // If Node 18+ you can remove this import

const CONFIG = {
  streamsApi: "https://ani-box-nine.vercel.app/api/grok-chat",
  controlApi: "https://ovubovyckalyentrgahb.supabase.co/rest/v1/isState",
  controlToken: "sb_publishable_D1BH-HDP_S_myTuLK_q0gg_LbWZ0g5K",
  controlPollInterval: 20_000,
  healthCheckInterval: 30_000,
  reportInterval: 5 * 60_000,
  maxRetries: 1,
  restartDelay: 10_000,
  globalRestartAfter: 3.75 * 60 * 60 * 1000,
  telegram: {
    botToken: "7971806903:AAHwpdNzkk6ClL3O17JVxZnp5e9uI66L9WE",
    chatId: "-1002181683719",
  }
};

const CONTROL_HEADERS = {
  apikey: CONFIG.controlToken,
  Authorization: `Bearer ${CONFIG.controlToken}`
};

const FACEBOOK_FFMPEG_OPTIONS = {
  input: ["-re","-fflags", "+genpts","-avoid_negative_ts", "make_zero","-reconnect", "1","-reconnect_streamed", "1","-reconnect_delay_max", "5","-user_agent", "Mozilla/5.0"],
  output: ["-c:v", "libx264","-preset", "veryfast","-tune", "zerolatency","-profile:v", "high","-level", "4.1","-pix_fmt", "yuv420p","-r", "30","-g", "60","-keyint_min", "60","-sc_threshold", "0","-bf", "2","-b:v", "4500k","-maxrate", "4500k","-bufsize", "9000k","-c:a", "aac","-b:a", "128k","-ar", "44100","-ac", "2","-f", "flv","-flvflags", "no_duration_filesize"]
};

let allItems = new Map();
let activeStreams = new Map();
let streamRetries = new Map();
let systemState = "stopped";
let globalRestartTimer = null;
let startTime = Date.now();

class Logger {
  static log(l, m) { const line = `[${new Date().toISOString()}] [${l}] ${m}`; console.log(line); try { fs.appendFileSync("system.log", line + "\n"); } catch(e){} }
  static info(m){this.log("INFO",m)}
  static warn(m){this.log("WARN",m)}
  static error(m){this.log("ERROR",m)}
  static success(m){this.log("SUCCESS",m)}
}

class Telegram {
  static async send(text) {
    try { await fetch(`https://api.telegram.org/bot${CONFIG.telegram.botToken}/sendMessage`, { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ chat_id: CONFIG.telegram.chatId, text, parse_mode: 'HTML' }) }); } catch (err) { Logger.error("Telegram send error: " + (err.message || err)); }
  }
}

class FacebookAPI {
  static async createLive(token, name) {
    const res = await fetch("https://graph.facebook.com/v24.0/me/live_videos", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ title: name, status: "UNPUBLISHED", access_token: token }) });
    const j = await res.json();
    if(j.error) throw new Error(j.error.message || JSON.stringify(j.error));
    return { id: j.id };
  }

  static async getPreview(liveId, token) {
    try {
      const res = await fetch(`https://graph.facebook.com/v24.0/${liveId}?fields=status,stream_url,secure_stream_url,dash_preview_url,permalink_url,embed_html&access_token=${encodeURIComponent(token)}`);
      const j = await res.json();
      if(j.error) throw new Error(j.error.message || JSON.stringify(j.error));
      return {
        status: j.status || null,
        stream_url: j.stream_url || null,
        secure_stream_url: j.secure_stream_url || null,
        dash_preview_url: j.dash_preview_url || null,
        permalink_url: j.permalink_url || null,
        embed_html: j.embed_html || null
      };
    } catch(e){ throw new Error('Facebook preview fetch failed: ' + e.message); }
  }
}

function extractMPDFromPreview(preview){ if(!preview) return null; const candidates=[preview.dash_preview_url,preview.secure_stream_url,preview.stream_url,preview.permalink_url]; for(const c of candidates){ if(!c) continue; try{ if(c.includes('.mpd')) return c; if(c.includes('dash')||c.includes('manifest')||c.includes('mpd')) return c; } catch(e){ continue; } } return null; }
function escapeHtml(text){ if(!text) return ''; return text.replace(/&/g, '&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

class StreamManager {
  static async startFFmpeg(item){
    Logger.info(`🎬 Starting ${item.name}`);

    try {
      // Get RTMPS dynamically from live preview
      const preview = await FacebookAPI.getPreview(item.streamId, item.token);
      item.preview = preview;
      item.rtmps = preview.stream_url || preview.secure_stream_url;
      if(!item.rtmps) throw new Error('No RTMPS URL available');

      const cmd = ffmpeg(item.source)
        .inputOptions(FACEBOOK_FFMPEG_OPTIONS.input)
        .outputOptions(FACEBOOK_FFMPEG_OPTIONS.output)
        .output(item.rtmps)
        .on("start", async c => {
          Logger.success(`▶ ${item.name} started streaming`);
          fs.appendFileSync(`ffmpeg_${item.id}.cmd.txt`, c + "\n");

          const mpd = extractMPDFromPreview(preview) || 'N/A';
          const msg = `✅ <b>LIVE</b>\n<b>${escapeHtml(item.name)}</b>\nChannel: ${preview.permalink_url||'N/A'}\nDASH preview (MPD): ${mpd}\nRTMPS: ${item.rtmps}`;
          await Telegram.send(msg);
        })
        .on("progress", () => { const i = activeStreams.get(item.id); if(i) i.lastOutput = Date.now(); })
        .on("stderr", line => { fs.appendFileSync(`ffmpeg_${item.id}.log`, `[${new Date().toISOString()}] ${line}\n`); })
        .on("error", e => { Logger.error(`❌ ${item.name}: ${e.message}`); StreamManager.handleFailure(item, e.message); })
        .on("end", () => { Logger.warn(`⏹ ${item.name} ended`); StreamManager.handleFailure(item, "Stream ended"); });

      activeStreams.set(item.id, { command: cmd, item, lastOutput: Date.now() });
      cmd.run();

    } catch(e){
      Logger.error(`Failed to get RTMPS URL for ${item.name}: ${e.message}`);
      await StreamManager.handleFailure(item,e.message);
    }
  }

  static async handleFailure(item, reason){
    const r = (streamRetries.get(item.id) || 0)+1;
    streamRetries.set(item.id,r);
    if(r<=CONFIG.maxRetries && systemState==='running'){ Logger.warn(`🔁 Retry ${item.name}`); await StreamManager.restartSingle(item); return; }
    Logger.error(`🛑 ${item.name} stopped permanently`);
    await Telegram.send(`❌ LIVE STOPPED\n${item.name}\n${reason}`);
    const info = activeStreams.get(item.id); try{ info?.command.kill('SIGTERM'); }catch{} activeStreams.delete(item.id);
  }

  static async restartSingle(item){
    const info = activeStreams.get(item.id); try{ info?.command.kill('SIGTERM'); }catch{} activeStreams.delete(item.id);
    const live = await FacebookAPI.createLive(item.token,item.name);
    item.streamId = live.id;
    await new Promise(r=>setTimeout(r,3000));
    await StreamManager.startFFmpeg(item);
  }

  static stopAll(){ activeStreams.forEach(i=>{try{i.command.kill('SIGTERM');}catch{}}); activeStreams.clear(); streamRetries.clear();}
}

class System{
  static async fetchStreams(){ const r=await fetch(CONFIG.streamsApi); const j=await r.json(); const map=new Map(); j.data.forEach((it,i)=>{ map.set(`item_${i}`,{ id:`item_${i}`, token:it.token, name:it.name, source:it.source }); }); return map; }

  static async start(){ if(systemState==='running') return; systemState='running'; startTime=Date.now(); Logger.success("▶ SYSTEM START"); await Telegram.send("▶ <b>SYSTEM STARTED</b>");
  allItems = await this.fetchStreams();
  for(const item of allItems.values()){
    const live = await FacebookAPI.createLive(item.token,item.name);
    item.streamId = live.id;
    await StreamManager.startFFmpeg(item);
    await new Promise(r=>setTimeout(r,2000));
  }
  try{ await waitForAllStartedOrTimeout(Array.from(allItems.keys()).length,30000); await System.sendPreviewReport(); }catch(e){ Logger.warn('Preview report: '+e.message); await System.sendPreviewReport(); }
  if(globalRestartTimer) clearTimeout(globalRestartTimer);
  globalRestartTimer=setTimeout(()=>{ System.restart("Scheduled 3h45m restart"); },CONFIG.globalRestartAfter);
  }

  static async stop(reason="Manual stop"){ if(systemState==='stopped') return; Logger.warn("⛔ SYSTEM STOP"); await Telegram.send(`⛔ <b>SYSTEM STOPPED</b>\n${escapeHtml(reason)}`); systemState='stopped'; StreamManager.stopAll(); if(globalRestartTimer) clearTimeout(globalRestartTimer); }
  static async restart(reason){ Logger.warn("♻ SYSTEM RESTART"); await Telegram.send(`♻ <b>SYSTEM RESTART</b>\n${escapeHtml(reason)}`); systemState='restarting'; StreamManager.stopAll(); setTimeout(async()=>{ await System.start(); },CONFIG.restartDelay); }

  static async sendPreviewReport(){ const lines=[]; for(const item of allItems.values()){ let preview=item.preview; if(!preview && item.streamId){ try{ preview=await FacebookAPI.getPreview(item.streamId,item.token); item.preview=preview; }catch(e){preview=null;} } const mpd=extractMPDFromPreview(preview)||'N/A'; const rtmps=preview?.stream_url||preview?.secure_stream_url||'N/A'; const permalink=preview?.permalink_url||'N/A'; lines.push(`<b>${escapeHtml(item.name)}</b>\nChannel: ${permalink}\nDASH: ${mpd}\nRTMPS: ${rtmps}`); } const text=`📡 <b>LIVE PREVIEW REPORT</b>\n\n${lines.join('\n\n')}`; await Telegram.send(text); Logger.info('Preview report sent to telegram'); }
}

async function waitForAllStartedOrTimeout(expectedCount,timeoutMs=30000){ const start=Date.now(); while((Date.now()-start)<timeoutMs){ if(activeStreams.size>=expectedCount) return; await new Promise(r=>setTimeout(r,1000)); } throw new Error('Timeout waiting for all ffmpeg processes to start'); }

setInterval(async()=>{ try{ const r=await fetch(CONFIG.controlApi+"?select=Action&order=id.desc&limit=1",{ headers:CONTROL_HEADERS }); const j=await r.json(); const action=j[0]?.Action?.toLowerCase(); if(action=="start") await System.start(); if(action=="stop") await System.stop("Supabase Control API"); if(action=="restart") await System.restart("Supabase Control API"); }catch(err){Logger.error("Control API poll error: "+err.message);} },CONFIG.controlPollInterval);
setInterval(()=>{ if(systemState!=='running') return; const now=Date.now(); activeStreams.forEach(info=>{ if(now-info.lastOutput>60000){ StreamManager.handleFailure(info.item,"No output 60s"); } }); },CONFIG.healthCheckInterval);
setInterval(async()=>{ if(systemState!=='running') return; const up=Math.floor((Date.now()-startTime)/60000); await Telegram.send(`📡 STATUS\nUptime: ${up} min\nActive: ${activeStreams.size}`); },CONFIG.reportInterval);
Logger.success("🟡 SYSTEM READY – WAITING FOR START");
export default System;
