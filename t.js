/******************************************************************
 * FACEBOOK MULTI STREAM MANAGER
 * Author: You
 * Description:
 * - Fetch streams from API
 * - Create Facebook Live
 * - Wait 15 seconds before FFmpeg
 * - Start FFmpeg
 * - Wait for ALL streams to be running
 * - Then fetch DASH URLs (MPD)
 * - Send full Telegram reports
 * - Handle exceptions with minimal delay
 ******************************************************************/

// ================== IMPORTS ==================
import { spawn } from "child_process";
import fs from "fs";

// ================== CONFIG ==================
const CONFIG = {
  apiUrl: "https://ani-box-nine.vercel.app/api/grok-chat",

  pollInterval: 60_000,          // Check every minute for API changes
  restartDelay: 30_000,          // ⏳ Wait ONLY 30 seconds after any exception
  reportInterval: 5 * 60_000,    // 📊 Telegram report every 5 minutes
  healthCheckInterval: 30_000,   // Health check every 30 seconds
  maxRetries: 3,                 // Max retries per stream before full restart
  preStartDelay: 15_000,         // Wait 15 seconds before starting FFmpeg
  ffmpegStartDelay: 2_000,       // Delay between FFmpeg starts (2 seconds)

  telegram: {
    botToken: "7971806903:AAHwpdNzkk6ClL3O17JVxZnp5e9uI66L9WE",
    chatId: "-1002181683719",
  }
};

// ================== GLOBAL STATE ==================
let allItems = new Map();        // All streams
let activeStreams = new Map();   // FFmpeg processes with metadata
let isRestarting = false;
let startTime = Date.now();
let apiDataHash = "";           // Store hash of API data to detect changes
let streamRetries = new Map();  // Track retry counts per stream

// ================== LOGGER ==================
class Logger {
  static log(level, msg) {
    const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
    console.log(line);
    fs.appendFileSync("logs.txt", line + "\n");
  }
  static info(m) { this.log("INFO", m); }
  static warn(m) { this.log("WARN", m); }
  static error(m) { this.log("ERROR", m); }
  static success(m) { this.log("SUCCESS", m); }
}

// ================== TELEGRAM ==================
class Telegram {
  static async send(text) {
    const url = `https://api.telegram.org/bot${CONFIG.telegram.botToken}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CONFIG.telegram.chatId,
        text,
        parse_mode: "HTML"
      })
    });
  }
}

// ================== FACEBOOK ==================
class FacebookAPI {
  // Create Facebook Live
  static async createLive(token, name) {
    const res = await fetch(
      "https://graph.facebook.com/v24.0/me/live_videos",
      {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        },
        body: JSON.stringify({
          title: name,
          status: "UNPUBLISHED",
          access_token: token
        })
      }
    );
    const json = await res.json();
    if (json.error) throw new Error(json.error.message);
    return {
      id: json.id,
      rtmps: json.secure_stream_url
    };
  }

  // Get DASH after FFmpeg starts
  static async getDash(id, token) {
    const res = await fetch(
      `https://graph.facebook.com/v24.0/${id}?fields=dash_preview_url&access_token=${token}`,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        }
      }
    );
    const json = await res.json();
    if (json.error) throw new Error(json.error.message);
    return json.dash_preview_url;
  }
}

// ================== FFMPEG ERROR ANALYZER ==================
class FfmpegErrorAnalyzer {
  static analyzeErrorMessage(errorMsg) {
    const error = errorMsg.toLowerCase();
    let type = "Unknown Error";
    let details = errorMsg.slice(0, 200);
    let solution = "Check logs for details";
    
    // Network/Connection Errors
    if (error.includes("connection refused") || error.includes("connection failed")) {
      type = "Connection Error";
      details = "Cannot connect to source server";
      solution = "Check if source server is online";
    }
    else if (error.includes("no route to host") || error.includes("network is unreachable")) {
      type = "Network Error";
      details = "Network route to server unavailable";
      solution = "Check network connectivity";
    }
    else if (error.includes("connection timed out") || error.includes("timeout")) {
      type = "Timeout Error";
      details = "Connection to source timed out";
      solution = "Server may be overloaded";
    }
    else if (error.includes("end of file") || error.includes("eof")) {
      type = "Stream Ended";
      details = "Source stream ended unexpectedly";
      solution = "Source server stopped streaming";
    }
    
    // Input/URL Errors
    else if (error.includes("invalid data found") || error.includes("invalid input")) {
      type = "Input Format Error";
      details = "Source stream format not recognized";
      solution = "Check source URL format";
    }
    else if (error.includes("server returned") || error.includes("401") || error.includes("403")) {
      type = "Authentication Error";
      details = "Source server rejected connection";
      solution = "Check credentials";
    }
    else if (error.includes("404") || error.includes("not found")) {
      type = "URL Not Found";
      details = "Source URL does not exist";
      solution = "Verify source URL";
    }
    else if (error.includes("protocol not found")) {
      type = "Protocol Error";
      details = "Unsupported streaming protocol";
      solution = "Check protocol support";
    }
    
    // FFmpeg/Encoding Errors
    else if (error.includes("cannot open resource") || error.includes("failed to open")) {
      type = "Resource Error";
      details = "Cannot open source stream";
      solution = "Source may be offline";
    }
    else if (error.includes("input/output error")) {
      type = "I/O Error";
      details = "Disk or network I/O error";
      solution = "Check system resources";
    }
    else if (error.includes("bitstream filter not found")) {
      type = "Codec Error";
      details = "Unsupported codec";
      solution = "FFmpeg may need codecs";
    }
    
    // Output/Destination Errors
    else if (error.includes("failed to update header") || error.includes("broken pipe")) {
      type = "Output Error";
      details = "Cannot write to Facebook";
      solution = "Check Facebook token";
    }
    else if (error.includes("access denied") || error.includes("permission denied")) {
      type = "Permission Error";
      details = "Access denied to destination";
      solution = "Check Facebook access";
    }
    
    return { type, details, solution };
  }
  
  static getDetailedReport(errorMsg, streamName) {
    const analysis = this.analyzeErrorMessage(errorMsg);
    return {
      title: `🔴 FFmpeg Error: ${streamName}`,
      errorType: analysis.type,
      errorDetails: analysis.details,
      solution: analysis.solution,
      timestamp: new Date().toISOString(),
      rawError: errorMsg.slice(0, 300)
    };
  }
}

// ================== STREAM MANAGER ==================
class StreamManager {
  static startFFmpeg(item) {
    try {
      Logger.info(`Starting FFmpeg for: ${item.name}`);
      
      // Increment retry counter
      const currentRetries = streamRetries.get(item.id) || 0;
      streamRetries.set(item.id, currentRetries + 1);
      console.log(item.source);
      // FFmpeg command with User-Agent
      const ff = spawn("ffmpeg", [
        "-re",
       
        "-i", item.source,
        "-c", "copy",
        "-f", "flv",
        item.rtmps
      ], {
        detached: true
      });

      // Store stream info with metadata
      activeStreams.set(item.id, {
        process: ff,
        item: item,
        startTime: Date.now(),
        status: "running",
        retries: currentRetries + 1,
        lastOutput: Date.now(),
        lastError: null,
        errorCount: 0
      });

      // Monitor FFmpeg output
      ff.stdout.on("data", d => {
        const streamInfo = activeStreams.get(item.id);
        if (streamInfo) {
          streamInfo.lastOutput = Date.now();
        }
      });

      ff.stderr.on("data", d => {
        const msg = d.toString();
        const streamInfo = activeStreams.get(item.id);
        if (streamInfo) {
          streamInfo.lastOutput = Date.now();
          
          // Log FFmpeg output for debugging
          if (msg.trim().length > 0) {
            fs.appendFileSync(`ffmpeg_${item.id}.log`, `[${new Date().toISOString()}] ${msg}`);
          }
        }
        
        // Check for errors
        if (this.isErrorMessage(msg)) {
          const errorAnalysis = FfmpegErrorAnalyzer.getDetailedReport(msg, item.name);
          streamInfo.lastError = errorAnalysis;
          streamInfo.errorCount = (streamInfo.errorCount || 0) + 1;
          
          Logger.error(`FFmpeg error [${item.name}]: ${errorAnalysis.errorType} - ${errorAnalysis.errorDetails}`);
          
          // Send error to Telegram (limited to avoid spam)
          if (streamInfo.errorCount <= 2) {
            Telegram.send(
              `🔴 FFmpeg Error: ${item.name}\n\n` +
              `📛 Type: ${errorAnalysis.errorType}\n` +
              `📋 Details: ${errorAnalysis.errorDetails}\n` +
              `🛠️ Solution: ${errorAnalysis.solution}\n` +
              `🔄 Retry: ${streamInfo.retries}/${CONFIG.maxRetries}`
            );
          }
          
          // Individual stream failure handling
          if (streamInfo && streamInfo.retries <= CONFIG.maxRetries) {
            Logger.info(`Attempting to restart stream: ${item.name} (retry ${streamInfo.retries}/${CONFIG.maxRetries})`);
            setTimeout(() => {
              StreamManager.restartStream(item.id, errorAnalysis.errorType);
            }, 5000);
          } else {
            // Too many retries
            ExceptionHandler.trigger(`FFmpeg Error in ${item.name} - ${errorAnalysis.errorType}`);
          }
        }
      });

      ff.on("exit", (code, signal) => {
        let exitReason = "";
        if (code !== null) {
          exitReason = `Exit code: ${code}`;
        } else if (signal !== null) {
          exitReason = `Killed by signal: ${signal}`;
        }
        
        Logger.warn(`FFmpeg exited [${item.name}]: ${exitReason}`);
        
        const streamInfo = activeStreams.get(item.id);
        if (streamInfo) {
          streamInfo.status = "stopped";
          streamInfo.exitCode = code;
          streamInfo.exitSignal = signal;
          streamInfo.stopTime = Date.now();
        }
        
        // Individual stream restart logic
        if (streamInfo && streamInfo.retries <= CONFIG.maxRetries) {
          Logger.info(`Stream ${item.name} exited, attempting restart (retry ${streamInfo.retries}/${CONFIG.maxRetries})`);
          
          setTimeout(() => {
            StreamManager.restartStream(item.id, "Process Exit");
          }, 5000);
        } else {
          ExceptionHandler.trigger(`FFmpeg Exit in ${item.name} - Max retries`);
        }
      });

      ff.on("error", (err) => {
        Logger.error(`FFmpeg spawn error [${item.name}]: ${err.message}`);
        const errorAnalysis = FfmpegErrorAnalyzer.getDetailedReport(err.message, item.name);
        
        Telegram.send(
          `🚨 FFmpeg Spawn Error: ${item.name}\n\n` +
          `📛 Type: ${errorAnalysis.errorType}\n` +
          `📋 Details: ${errorAnalysis.errorDetails}\n` +
          `🛠️ Solution: ${errorAnalysis.solution}`
        );
        
        ExceptionHandler.trigger(`FFmpeg Spawn Error in ${item.name}`);
      });

      ff.unref();
      
      return true;
    } catch (error) {
      Logger.error(`Failed to start FFmpeg for ${item.name}: ${error.message}`);
      
      const errorAnalysis = FfmpegErrorAnalyzer.getDetailedReport(error.message, item.name);
      Telegram.send(
        `🚨 FFmpeg Start Failed: ${item.name}\n\n` +
        `📛 Type: ${errorAnalysis.errorType}\n` +
        `📋 Details: ${errorAnalysis.errorDetails}\n` +
        `🛠️ Solution: ${errorAnalysis.solution}`
      );
      
      return false;
    }
  }

  // Check if message contains error
  static isErrorMessage(msg) {
    const errorMsg = msg.toLowerCase();
    return (
      errorMsg.includes("error") ||
      errorMsg.includes("failed") ||
      errorMsg.includes("connection refused") ||
      errorMsg.includes("no route to host") ||
      errorMsg.includes("connection timed out") ||
      errorMsg.includes("invalid data found") ||
      errorMsg.includes("server returned") ||
      errorMsg.includes("input/output error") ||
      errorMsg.includes("cannot open resource") ||
      errorMsg.includes("protocol not found") ||
      errorMsg.includes("404 not found") ||
      errorMsg.includes("401 unauthorized") ||
      errorMsg.includes("403 forbidden") ||
      errorMsg.includes("end of file") ||
      errorMsg.includes("eof") ||
      errorMsg.includes("broken pipe") ||
      errorMsg.includes("access denied")
    );
  }

  // Restart individual stream
  static async restartStream(streamId, errorReason = "Unknown") {
    const streamInfo = activeStreams.get(streamId);
    if (!streamInfo) {
      Logger.warn(`Cannot restart stream ${streamId}: not found`);
      return;
    }

    const item = streamInfo.item;
    
    if (streamInfo.process && !streamInfo.process.killed) {
      streamInfo.process.kill('SIGTERM');
    }
    
    activeStreams.delete(streamId);
    
    try {
      Logger.info(`Creating new Facebook Live for: ${item.name} (Previous error: ${errorReason})`);
      const live = await FacebookAPI.createLive(item.token, item.name);
      item.streamId = live.id;
      item.rtmps = live.rtmps;
      
      // Wait before starting FFmpeg
      Logger.info(`Waiting before starting FFmpeg for: ${item.name}`);
      await new Promise(r => setTimeout(r, 5000)); // 5 seconds wait
      
      StreamManager.startFFmpeg(item);
      
      await Telegram.send(
        `🔄 Stream Restarted: ${item.name}\n\n` +
        `📛 Previous error: ${errorReason}\n` +
        `🆔 New stream ID: ${item.streamId}`
      );
      
    } catch (error) {
      Logger.error(`Failed to recreate Facebook Live for ${item.name}: ${error.message}`);
      ExceptionHandler.trigger(`Failed to recreate stream ${item.name}`);
    }
  }

  static stopAll() {
    activeStreams.forEach((info, id) => {
      if (info.process && !info.process.killed) {
        info.process.kill("SIGTERM");
      }
    });
    activeStreams.clear();
    streamRetries.clear();
  }

  // Health check for streams
  static async healthCheck() {
    const now = Date.now();
    const deadStreams = [];
    
    activeStreams.forEach((info, streamId) => {
      if (info.process && info.process.killed) {
        Logger.warn(`Stream ${info.item.name} process is killed`);
        deadStreams.push(streamId);
      }
      else if (info.status === "running" && now - info.lastOutput > 60000) {
        Logger.warn(`Stream ${info.item.name} has no output for 60+ seconds`);
        deadStreams.push(streamId);
      }
    });
    
    // Restart dead streams
    for (const streamId of deadStreams) {
      const info = activeStreams.get(streamId);
      if (info && info.retries <= CONFIG.maxRetries) {
        Logger.info(`Health check: restarting dead stream ${info.item.name}`);
        await StreamManager.restartStream(streamId, "Health Check");
      }
    }
    
    return deadStreams.length;
  }

  // Check if all FFmpeg processes are running
  static areAllStreamsRunning() {
    return Array.from(allItems.values()).every(item => {
      const streamInfo = activeStreams.get(item.id);
      return streamInfo && streamInfo.status === "running";
    });
  }

  // Wait for all streams to be running
  static async waitForAllStreams(timeout = 90000) { // 90 seconds timeout
    const start = Date.now();
    const checkInterval = 2000;
    
    while (Date.now() - start < timeout) {
      if (this.areAllStreamsRunning()) {
        Logger.success("All streams are running!");
        return true;
      }
      
      const runningCount = Array.from(allItems.values()).filter(item => {
        const streamInfo = activeStreams.get(item.id);
        return streamInfo && streamInfo.status === "running";
      }).length;
      
      Logger.info(`Waiting for streams: ${runningCount}/${allItems.size} running`);
      
      await new Promise(r => setTimeout(r, checkInterval));
    }
    
    Logger.warn(`Timeout waiting for all streams to start`);
    return false;
  }
}

// ================== EXCEPTION HANDLER ==================
class ExceptionHandler {
  static async trigger(reason) {
    if (isRestarting) return;
    isRestarting = true;

    Logger.warn(`Exception: ${reason}`);
    await Telegram.send(`⚠️ System Exception\n${reason}\n⏳ Restarting in 30 seconds...`);

    setTimeout(async () => {
      await Main.restart();
      isRestarting = false;
    }, CONFIG.restartDelay); // Now only 30 seconds
  }
}

// ================== API CHANGE DETECTOR ==================
class ApiChangeDetector {
  static createDataHash(data) {
    const itemsString = data.map(item => 
      `${item.token}|${item.name}|${item.source}|${item.img}`
    ).sort().join('||');
    
    return Buffer.from(itemsString).toString('base64');
  }

  static async checkForChanges() {
    try {
      Logger.info("Checking API for changes...");
      
      const res = await fetch(CONFIG.apiUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        }
      });
      const json = await res.json();
      
      const newHash = this.createDataHash(json.data);
      
      if (apiDataHash === "") {
        apiDataHash = newHash;
        Logger.info("Initial API data hash stored");
        return false;
      }
      
      if (newHash !== apiDataHash) {
        Logger.info(`API data changed!`);
        
        const oldCount = allItems.size;
        const newCount = json.data.length;
        await Telegram.send(
          `🔄 API Changes Detected!\n\n` +
          `📊 Previous streams: ${oldCount}\n` +
          `📊 New streams: ${newCount}\n` +
          `⏳ Restarting in 30 seconds...`
        );
        
        apiDataHash = newHash;
        ExceptionHandler.trigger("API data changed");
        return true;
      }
      
      Logger.info("No changes in API data");
      return false;
      
    } catch (error) {
      Logger.error(`Error checking API changes: ${error.message}`);
      return false;
    }
  }
}

// ================== MAIN ==================
class Main {
  // Fetch data from API
  static async fetchItems() {
    const res = await fetch(CONFIG.apiUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
    });
    const json = await res.json();

    const map = new Map();
    json.data.forEach((it, i) => {
      map.set(`item_${i}`, {
        id: `item_${i}`,
        token: it.token,
        name: it.name,
        source: it.source,
        img: it.img
      });
    });
    
    if (apiDataHash === "") {
      apiDataHash = ApiChangeDetector.createDataHash(json.data);
    }
    
    streamRetries.clear();
    
    return map;
  }

  // Full startup
  static async start() {
    try {
      Logger.info("Fetching items from API...");
      allItems = await this.fetchItems();

      Logger.info(`Creating Facebook Live for ${allItems.size} streams...`);
      
      // 1️⃣ Create Facebook Live streams
      for (const item of allItems.values()) {
        try {
          const live = await FacebookAPI.createLive(item.token, item.name);
          item.streamId = live.id;
          item.rtmps = live.rtmps;
          Logger.info(`Created Facebook Live for: ${item.name} (ID: ${item.streamId})`);
        } catch (error) {
          Logger.error(`Failed to create Facebook Live for ${item.name}: ${error.message}`);
          item.failed = true;
          
          await Telegram.send(
            `❌ Facebook Live Creation Failed\n\n` +
            `📛 Stream: ${item.name}\n` +
            `📋 Error: ${error.message}`
          );
        }
      }

      // 2️⃣ Wait 15 seconds before starting FFmpeg
      Logger.info(`Waiting 15 seconds before starting FFmpeg...`);
      await new Promise(r => setTimeout(r, CONFIG.preStartDelay));

      // 3️⃣ Start FFmpeg with delays between starts
      Logger.info("Starting FFmpeg processes...");
      let ffmpegStarted = 0;
      
      for (const item of allItems.values()) {
        if (!item.failed) {
          if (ffmpegStarted > 0) {
            await new Promise(r => setTimeout(r, CONFIG.ffmpegStartDelay));
          }
          
          StreamManager.startFFmpeg(item);
          ffmpegStarted++;
        }
      }

      // 4️⃣ Wait for ALL streams to be running
      Logger.info("Waiting for all FFmpeg processes to start...");
      const allRunning = await StreamManager.waitForAllStreams();
      
      if (!allRunning) {
        throw new Error("Failed to start all streams");
      }

      // 5️⃣ Get DASH URLs (MPD) for all successful streams
      Logger.info("All streams running, fetching DASH URLs...");
      let report = `📊 STREAM REPORT\n\n`;
      let successCount = 0;
      
      for (const item of allItems.values()) {
        if (!item.failed) {
          try {
            item.dash = await FacebookAPI.getDash(item.streamId, item.token);
            
            report += `✅ ${item.name}\n`;
            report += `🔗 DASH (MPD): ${item.dash}\n`;
            report += `🆔 Facebook ID: ${item.streamId}\n\n`;
            
            successCount++;
            
          } catch (error) {
            report += `⚠️ ${item.name} - Failed to get DASH: ${error.message}\n\n`;
          }
        } else {
          report += `❌ ${item.name} - Failed to create Facebook Live\n\n`;
        }
      }

      report += `📈 Total: ${successCount}/${allItems.size} streams running`;
      
      // 6️⃣ Send Telegram report
      await Telegram.send(report);
      Logger.success(`All streams initialized: ${successCount}/${allItems.size} successful`);

    } catch (error) {
      Logger.error(`Startup error: ${error.message}`);
      throw error;
    }
  }

  static async restart() {
    Logger.warn("Restarting system...");
    StreamManager.stopAll();
    await this.start();
  }
}

// ================== PERIODIC CHECKS ==================

// 📊 Status report every 5 minutes
setInterval(async () => {
  if (!isRestarting) {
    const uptime = Math.floor((Date.now() - startTime) / 60000);
    const activeCount = Array.from(activeStreams.values())
      .filter(info => info.status === "running").length;
    
    await Telegram.send(
      `📡 Status Report\n\n` +
      `⏱️ Uptime: ${uptime} minutes\n` +
      `📊 Total streams: ${allItems.size}\n` +
      `🟢 Active streams: ${activeCount}\n` +
      `🔴 Inactive streams: ${allItems.size - activeCount}\n` +
      `🔄 Last check: ${new Date().toLocaleTimeString()}`
    );
  }
}, CONFIG.reportInterval);

// 🔍 API change check every minute
setInterval(async () => {
  if (!isRestarting) {
    await ApiChangeDetector.checkForChanges();
  } else {
    Logger.info("Skipping API check - system is restarting");
  }
}, CONFIG.pollInterval);

// 🩺 Health check every 30 seconds
setInterval(async () => {
  if (!isRestarting) {
    const deadCount = await StreamManager.healthCheck();
    if (deadCount > 0) {
      Logger.info(`Health check: Found ${deadCount} dead streams`);
    }
  }
}, CONFIG.healthCheckInterval);

// ================== START ==================
Main.start().catch(e => {
  Logger.error(`Initial error: ${e.message}`);
  ExceptionHandler.trigger("Initial Error");
});
