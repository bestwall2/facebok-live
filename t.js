import { spawn } from 'child_process';
import fetch from 'node-fetch';
import fs from 'fs';

// ================== CONFIGURATION ==================
const CONFIG = {
    // Telegram Bot Configuration
    telegram: {
        botToken: "7971806903:AAHwpdNzkk6ClL3O17JVxZnp5e9uI66L9WE",  // Get from @BotFather
        chatId: "5806630118",              // Get from @userinfobot
        enabled: true
    },
    
    // API Monitoring
    api: {
        url: "http://johan.xo.je/sd.php",
        pollInterval: 10000,  // Check every 10 seconds
        retryDelay: 5000      // Wait 5 seconds if API fails
    },
    
    // Logging
    logging: {
        logFile: "stream_monitor.log",
        telegramLogs: true,   // Send logs to Telegram
        consoleLogs: true     // Show logs in console
    }
};

// ================== GLOBAL STATE ==================
let activeStreams = new Map();  // Map<streamId, {process, info}>
let lastApiData = null;
let apiErrorCount = 0;
const MAX_API_ERRORS = 5;

// ================== LOGGER ==================
class Logger {
    static log(level, message, streamId = null) {
        const timestamp = new Date().toISOString();
        const logEntry = `[${timestamp}] [${level}] ${streamId ? `[${streamId}] ` : ''}${message}`;
        
        // Console logging
        if (CONFIG.logging.consoleLogs) {
            const colors = {
                INFO: '\x1b[36m',    // Cyan
                SUCCESS: '\x1b[32m', // Green
                WARNING: '\x1b[33m', // Yellow
                ERROR: '\x1b[31m',   // Red
                TELEGRAM: '\x1b[35m' // Magenta
            };
            console.log(`${colors[level] || ''}${logEntry}\x1b[0m`);
        }
        
        // File logging
        fs.appendFileSync(CONFIG.logging.logFile, logEntry + '\n');
        
        // Telegram notifications for important events
        if (CONFIG.logging.telegramLogs && CONFIG.telegram.enabled) {
            if (level === 'ERROR' || level === 'WARNING' || level === 'TELEGRAM') {
                this.sendToTelegram(`${level}: ${message}`, streamId).catch(console.error);
            }
        }
    }
    
    static async sendToTelegram(message, streamId = null) {
        if (!CONFIG.telegram.enabled || !CONFIG.telegram.botToken || !CONFIG.telegram.chatId) {
            return;
        }
        
        try {
            const fullMessage = streamId ? `[${streamId}] ${message}` : message;
            const url = `https://api.telegram.org/bot${CONFIG.telegram.botToken}/sendMessage`;
            
            await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: CONFIG.telegram.chatId,
                    text: fullMessage,
                    parse_mode: 'HTML'
                })
            });
        } catch (error) {
            console.error('Failed to send Telegram message:', error.message);
        }
    }
}

// ================== FFMPEG MANAGER ==================
class FFmpegManager {
    static startStream(streamInfo) {
        const { id, name, rtmps_url, rtmp_source } = streamInfo;
        
        Logger.log('INFO', `Starting stream: ${name}`, id);
        Logger.sendToTelegram(`🟢 Starting stream: <b>${name}</b>\nSource: ${rtmp_source}`, id);
        
        const args = [
            "-re",
            "-i", rtmp_source,
            "-map", "0:v:0",
            "-map", "0:a:0",
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-pix_fmt", "yuv420p",
            "-r", "25",
            "-g", "50",
            "-b:v", "3000k",
            "-maxrate", "3000k",
            "-bufsize", "6000k",
            "-c:a", "aac",
            "-ar", "44100",
            "-b:a", "128k",
            "-ac", "2",
            "-f", "flv",
            rtmps_url
        ];
        
        const ffmpeg = spawn("ffmpeg", args);
        
        // Log FFmpeg output
        ffmpeg.stderr.on('data', (data) => {
            const message = data.toString();
            
            // Filter important messages
            if (message.includes('frame=') && Math.random() < 0.1) {
                Logger.log('INFO', `FFmpeg progress: ${message.substring(0, 60)}...`, id);
            } else if (message.includes('error') || message.includes('fail')) {
                Logger.log('ERROR', `FFmpeg error: ${message.trim()}`, id);
                Logger.sendToTelegram(`🔴 FFmpeg error in ${name}: ${message.substring(0, 100)}`, id);
            }
        });
        
        ffmpeg.on('close', (code) => {
            Logger.log('WARNING', `FFmpeg exited with code ${code}`, id);
            Logger.sendToTelegram(`🟡 Stream ${name} stopped with code ${code}`, id);
            activeStreams.delete(id);
        });
        
        ffmpeg.on('error', (err) => {
            Logger.log('ERROR', `FFmpeg process error: ${err.message}`, id);
            Logger.sendToTelegram(`🔴 FFmpeg process error in ${name}: ${err.message}`, id);
            activeStreams.delete(id);
        });
        
        // Store the process
        activeStreams.set(id, {
            process: ffmpeg,
            info: streamInfo,
            startTime: new Date(),
            lastHeartbeat: new Date()
        });
        
        return ffmpeg;
    }
    
    static stopStream(streamId) {
        const stream = activeStreams.get(streamId);
        
        if (!stream) {
            Logger.log('WARNING', `Stream ${streamId} not found`, streamId);
            return false;
        }
        
        Logger.log('INFO', `Stopping stream: ${stream.info.name}`, streamId);
        Logger.sendToTelegram(`🟡 Stopping stream: <b>${stream.info.name}</b>`, streamId);
        
        stream.process.kill('SIGTERM');
        activeStreams.delete(streamId);
        
        return true;
    }
    
    static stopAllStreams() {
        Logger.log('INFO', 'Stopping all active streams');
        Logger.sendToTelegram('🟡 Stopping all active streams');
        
        let stoppedCount = 0;
        activeStreams.forEach((stream, streamId) => {
            stream.process.kill('SIGTERM');
            activeStreams.delete(streamId);
            stoppedCount++;
        });
        
        Logger.log('INFO', `Stopped ${stoppedCount} streams`);
        return stoppedCount;
    }
}

// ================== API MONITOR ==================
class APIMonitor {
    static async fetchStreamData() {
        try {
            const response = await fetch(CONFIG.api.url, {
                headers: { 'User-Agent': 'StreamMonitor/1.0' },
                timeout: 10000
            });
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            const data = await response.json();
            
            if (!data.success) {
                throw new Error('API returned success: false');
            }
            
            apiErrorCount = 0; // Reset error counter on success
            return data;
            
        } catch (error) {
            apiErrorCount++;
            Logger.log('ERROR', `API fetch failed (${apiErrorCount}/${MAX_API_ERRORS}): ${error.message}`);
            
            if (apiErrorCount >= MAX_API_ERRORS) {
                Logger.log('ERROR', 'Too many API errors, considering shutdown');
                Logger.sendToTelegram('🔴 CRITICAL: Too many API errors, system may be unstable');
            }
            
            return null;
        }
    }
    
    static async processNewData(apiData) {
        if (!apiData || !apiData.data) {
            Logger.log('WARNING', 'No valid data received from API');
            return;
        }
        
        const currentStreams = apiData.data;
        const currentTimestamp = apiData.timestamp || new Date().toISOString();
        
        // Check if this is the first run
        if (!lastApiData) {
            Logger.log('INFO', `First API response received. Timestamp: ${currentTimestamp}`);
            Logger.log('INFO', `Found ${currentStreams.length} total streams in API`);
            lastApiData = apiData;
            return;
        }
        
        // Compare with last data to detect changes
        const changes = this.detectChanges(lastApiData.data, currentStreams);
        
        if (changes.added.length > 0 || changes.removed.length > 0 || changes.updated.length > 0) {
            Logger.log('INFO', `API changes detected at ${currentTimestamp}`);
            Logger.sendToTelegram(`📊 API Update: +${changes.added.length} -${changes.removed.length} ~${changes.updated.length}`);
            
            // Process changes
            await this.handleChanges(changes, currentStreams);
        }
        
        lastApiData = apiData;
    }
    
    static detectChanges(oldStreams, newStreams) {
        const changes = {
            added: [],
            removed: [],
            updated: []
        };
        
        const oldMap = new Map(oldStreams.map(s => [s.id, s]));
        const newMap = new Map(newStreams.map(s => [s.id, s]));
        
        // Find added streams
        for (const [id, stream] of newMap) {
            if (!oldMap.has(id)) {
                changes.added.push(stream);
            }
        }
        
        // Find removed streams
        for (const [id, stream] of oldMap) {
            if (!newMap.has(id)) {
                changes.removed.push(stream);
            }
        }
        
        // Find updated streams
        for (const [id, newStream] of newMap) {
            const oldStream = oldMap.get(id);
            if (oldStream && JSON.stringify(oldStream) !== JSON.stringify(newStream)) {
                changes.updated.push(newStream);
            }
        }
        
        return changes;
    }
    
    static async handleChanges(changes, allStreams) {
        // Handle removed streams
        for (const removedStream of changes.removed) {
            if (activeStreams.has(removedStream.id)) {
                Logger.log('INFO', `Stream ${removedStream.name} removed from API, stopping FFmpeg`, removedStream.id);
                FFmpegManager.stopStream(removedStream.id);
            }
        }
        
        // Handle added and updated streams
        for (const stream of [...changes.added, ...changes.updated]) {
            // Only process active streams
            if (stream.status !== 'active') {
                if (activeStreams.has(stream.id)) {
                    Logger.log('INFO', `Stream ${stream.name} marked inactive, stopping`, stream.id);
                    FFmpegManager.stopStream(stream.id);
                }
                continue;
            }
            
            // Validate required fields
            if (!stream.rtmps_url || !stream.rtmp_source) {
                Logger.log('WARNING', `Stream ${stream.name} missing RTMPS URL or source`, stream.id);
                continue;
            }
            
            // Start new stream or restart if already running
            if (activeStreams.has(stream.id)) {
                Logger.log('INFO', `Restarting stream ${stream.name} due to update`, stream.id);
                FFmpegManager.stopStream(stream.id);
                await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
            }
            
            FFmpegManager.startStream(stream);
        }
        
        // Log summary
        if (changes.added.length + changes.removed.length + changes.updated.length > 0) {
            Logger.log('INFO', `Changes processed: ${changes.added.length} added, ${changes.removed.length} removed, ${changes.updated.length} updated`);
        }
    }
}

// ================== STREAM HEALTH CHECK ==================
async function performHealthCheck() {
    const now = new Date();
    let issues = 0;
    
    activeStreams.forEach((stream, streamId) => {
        // Check if process is still running
        if (stream.process.exitCode !== null) {
            Logger.log('WARNING', `Stream ${stream.info.name} process died, restarting`, streamId);
            FFmpegManager.stopStream(streamId);
            
            // Wait and restart if still active in API
            setTimeout(() => {
                if (lastApiData?.data?.find(s => s.id === streamId && s.status === 'active')) {
                    Logger.log('INFO', `Auto-restarting stream ${stream.info.name}`, streamId);
                    FFmpegManager.startStream(stream.info);
                }
            }, 5000);
            
            issues++;
        }
        
        // Update heartbeat
        stream.lastHeartbeat = now;
    });
    
    if (issues > 0) {
        Logger.log('WARNING', `Health check found ${issues} issues`);
    }
    
    return issues;
}

// ================== DASHBOARD ==================
function showDashboard() {
    console.log('\n' + '='.repeat(80));
    console.log('STREAM MONITOR DASHBOARD');
    console.log('='.repeat(80));
    
    console.log(`\n📊 API Status: ${lastApiData ? `✅ Last update: ${lastApiData.timestamp}` : '⏳ Waiting for first update'}`);
    console.log(`🔄 Active Streams: ${activeStreams.size}`);
    console.log(`📈 API Error Count: ${apiErrorCount}/${MAX_API_ERRORS}`);
    
    if (activeStreams.size > 0) {
        console.log('\n' + '-'.repeat(80));
        console.log('ACTIVE STREAMS:');
        console.log('-'.repeat(80));
        
        activeStreams.forEach((stream, streamId) => {
            const uptime = Math.floor((new Date() - stream.startTime) / 1000);
            console.log(`\n📺 ${stream.info.name} [ID: ${streamId}]`);
            console.log(`   🕐 Uptime: ${Math.floor(uptime / 60)}m ${uptime % 60}s`);
            console.log(`   📤 Source: ${stream.info.rtmp_source.substring(0, 50)}...`);
            console.log(`   📥 Destination: ${stream.info.rtmps_url.substring(0, 50)}...`);
            console.log(`   🎥 Status: ${stream.process.exitCode === null ? '✅ RUNNING' : '❌ STOPPED'}`);
        });
    } else {
        console.log('\n📭 No active streams running');
    }
    
    console.log('\n' + '='.repeat(80));
    console.log('Press Ctrl+C to shutdown gracefully');
    console.log('='.repeat(80) + '\n');
}

// ================== MAIN APPLICATION ==================
async function main() {
    console.log('\n' + '🚀'.repeat(30));
    console.log('AUTO STREAM MONITOR SERVER');
    console.log('Starting up...');
    console.log('🚀'.repeat(30) + '\n');
    
    Logger.log('TELEGRAM', '🚀 Stream Monitor Server Started');
    
    // Initial API fetch
    Logger.log('INFO', 'Performing initial API fetch...');
    const initialData = await APIMonitor.fetchStreamData();
    await APIMonitor.processNewData(initialData);
    
    // Main monitoring loop
    const monitoringLoop = async () => {
        try {
            const apiData = await APIMonitor.fetchStreamData();
            await APIMonitor.processNewData(apiData);
            
            // Perform health check every 30 seconds
            if (Date.now() % 30000 < CONFIG.api.pollInterval) {
                await performHealthCheck();
            }
            
            // Show dashboard every minute
            if (Date.now() % 60000 < CONFIG.api.pollInterval) {
                showDashboard();
            }
            
        } catch (error) {
            Logger.log('ERROR', `Monitoring loop error: ${error.message}`);
        }
    };
    
    // Start periodic monitoring
    const monitorInterval = setInterval(monitoringLoop, CONFIG.api.pollInterval);
    
    // Handle graceful shutdown
    process.on('SIGINT', async () => {
        clearInterval(monitorInterval);
        
        console.log('\n' + '🛑'.repeat(30));
        console.log('GRACEFUL SHUTDOWN INITIATED');
        console.log('🛑'.repeat(30));
        
        Logger.log('INFO', 'Server shutdown initiated');
        Logger.sendToTelegram('🛑 Stream Monitor Server Shutting Down');
        
        const stoppedCount = FFmpegManager.stopAllStreams();
        
        console.log(`\n✅ Stopped ${stoppedCount} streams`);
        console.log('📝 Logs saved to:', CONFIG.logging.logFile);
        console.log('\n👋 Goodbye!\n');
        
        process.exit(0);
    });
    
    // Initial dashboard
    showDashboard();
    
    // Keep process alive
    await new Promise(() => {});
}

// ================== STARTUP VALIDATION ==================
function validateConfig() {
    const issues = [];
    
    if (!CONFIG.telegram.botToken || CONFIG.telegram.botToken === "YOUR_TELEGRAM_BOT_TOKEN") {
        issues.push("Telegram bot token not configured");
        CONFIG.telegram.enabled = false;
    }
    
    if (!CONFIG.telegram.chatId || CONFIG.telegram.chatId === "YOUR_CHAT_ID") {
        issues.push("Telegram chat ID not configured");
        CONFIG.telegram.enabled = false;
    }
    
    if (issues.length > 0) {
        console.log('\n⚠️ Configuration issues found:');
        issues.forEach(issue => console.log(`  • ${issue}`));
        console.log('\nSome features may be disabled.\n');
    }
    
    return issues.length === 0;
}

// ================== RUN APPLICATION ==================
if (validateConfig()) {
    main().catch(error => {
        console.error('💥 Fatal error:', error);
        Logger.sendToTelegram(`🔴 CRITICAL: Server crashed - ${error.message}`);
        process.exit(1);
    });
} else {
    console.log('Starting with limited functionality...\n');
    main().catch(console.error);
}
