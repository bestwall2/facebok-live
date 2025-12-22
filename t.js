
import { spawn } from 'child_process';
import fetch from 'node-fetch';
import fs from 'fs';

// ================== CONFIGURATION ==================
const CONFIG = {
    telegram: {    
        botToken: "7971806903:AAHwpdNzkk6ClL3O17JVxZnp5e9uI66L9WE",  // Get from @BotFather
        chatId: "5806630118",              // Get from @userinfobot
        enabled: true,
        // Only send these alerts to Telegram
        alertOn: {
            newStream: true,
            streamStopped: true,
            streamModified: true,
            ffmpegError: true,
            apiError: false  // Don't spam on API errors
        }
    },
    
    api: {
        url: "https://johan.xo.je/sd.php",
        pollInterval: 30000,  // Check every 30 seconds (was 10)
        retryDelay: 10000,
        maxHtmlErrors: 3,     // Allow some HTML responses
        maxConsecutiveErrors: 10  // More tolerance
    },
    
    logging: {
        logFile: "stream_monitor.log",
        consoleLogs: true,
        // Status report intervals (5 minutes = 300000ms)
        statusReportInterval: 300000,
        lastStatusReport: 0
    }
};

// ================== GLOBAL STATE ==================
let activeStreams = new Map();
let lastApiData = null;
let apiErrorCount = 0;
let htmlErrorCount = 0;
let lastStatusReportTime = Date.now();

// ================== ENHANCED LOGGER ==================
class Logger {
    static log(level, message, streamId = null) {
        const timestamp = new Date().toISOString();
        const logEntry = `[${timestamp}] [${level}] ${streamId ? `[${streamId}] ` : ''}${message}`;
        
        // Console logging - LESS VERBOSE
        if (CONFIG.logging.consoleLogs) {
            // Only show errors, warnings, and important info
            if (level === 'ERROR' || level === 'WARNING' || level === 'TELEGRAM' || 
                (level === 'INFO' && message.includes('Starting') || message.includes('Stopping'))) {
                const colors = {
                    INFO: '\x1b[36m',
                    SUCCESS: '\x1b[32m',
                    WARNING: '\x1b[33m',
                    ERROR: '\x1b[31m',
                    TELEGRAM: '\x1b[35m'
                };
                console.log(`${colors[level] || ''}${logEntry}\x1b[0m`);
            }
        }
        
        // File logging (always)
        fs.appendFileSync(CONFIG.logging.logFile, logEntry + '\n');
        
        // Status report every 5 minutes
        const now = Date.now();
        if (now - lastStatusReportTime >= CONFIG.logging.statusReportInterval) {
            this.logStatusReport();
            lastStatusReportTime = now;
        }
    }
    
    static logStatusReport() {
        const activeCount = activeStreams.size;
        const totalStreams = lastApiData?.data?.length || 0;
        
        console.log('\n' + '📊'.repeat(30));
        console.log('5-MINUTE STATUS REPORT');
        console.log(`Total streams in API: ${totalStreams}`);
        console.log(`Currently active: ${activeCount}`);
        
        if (activeCount > 0) {
            console.log('\nActive Streams:');
            activeStreams.forEach((stream, id) => {
                const uptime = Math.floor((Date.now() - stream.startTime) / 1000);
                console.log(`  ${stream.info.name} (ID: ${id}) - Uptime: ${Math.floor(uptime/60)}m ${uptime%60}s`);
            });
        }
        
        console.log('📊'.repeat(30) + '\n');
        
        // Telegram status report (if enabled)
        if (CONFIG.telegram.enabled && CONFIG.telegram.alertOn.apiError) {
            this.sendToTelegram(`📊 Status Report: ${activeCount}/${totalStreams} streams active`, null);
        }
    }
    
    static async sendToTelegram(message, streamId = null, alertType = null) {
        // Check if this alert type should be sent
        if (alertType && !CONFIG.telegram.alertOn[alertType]) {
            return;
        }
        
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
            console.error('Telegram send failed:', error.message);
        }
    }
}

// ================== ROBUST API FETCHER ==================
class APIMonitor {
    static async fetchStreamData() {
        try {           
  
            const response = await fetch(CONFIG.api.url, {
                "headers": {
                "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
                "accept-language": "en-US,en;q=0.8",
                "cache-control": "max-age=0",
                "sec-ch-ua": "\"Brave\";v=\"143\", \"Chromium\";v=\"143\", \"Not A(Brand\";v=\"24\"",
                "sec-ch-ua-mobile": "?0",
                "sec-ch-ua-platform": "\"Windows\"",
                "sec-fetch-dest": "document",
                "sec-fetch-mode": "navigate",
                "sec-fetch-site": "none",
                "sec-fetch-user": "?1",
                "sec-gpc": "1",
                "upgrade-insecure-requests": "1"
              },
                timeout: 15000
            });
            
            const contentType = response.headers.get('content-type') || '';
            
            // Check if response is HTML (not JSON)
            if (contentType.includes('text/html')) {
                const text = await response.text();
                
                // Check if it's actually an error page
                if (text.includes('<html') || text.includes('<!DOCTYPE')) {
                    htmlErrorCount++;
                    
                    // If we get too many HTML responses, treat as maintenance
                    if (htmlErrorCount <= CONFIG.api.maxHtmlErrors) {
                        Logger.log('WARNING', `API returned HTML (${htmlErrorCount}/${CONFIG.api.maxHtmlErrors}): ${text.substring(0, 100)}...`);
                        return { success: true, data: [], count: 0, timestamp: new Date().toISOString() };
                    } else {
                        throw new Error(`API returning HTML instead of JSON. Service may be down.`);
                    }
                }
            }
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            
            const data = await response.json();
            
            if (!data.success) {
                throw new Error('API returned success: false');
            }
            
            // Reset error counters on success
            apiErrorCount = 0;
            htmlErrorCount = 0;
            
            return data;
            
        } catch (error) {
            apiErrorCount++;
            
            // Don't log every single error to console
            if (apiErrorCount % 5 === 1) {  // Log every 5th error
                Logger.log('ERROR', `API error ${apiErrorCount}/${CONFIG.api.maxConsecutiveErrors}: ${error.message}`);
            }
            
            if (apiErrorCount >= CONFIG.api.maxConsecutiveErrors) {
                Logger.log('ERROR', 'Too many consecutive API errors');
                Logger.sendToTelegram('🔴 CRITICAL: API unreachable for extended period', null, 'apiError');
                return null;
            }
            
            // Return empty data to keep monitoring
            return { success: true, data: [], count: 0, timestamp: new Date().toISOString() };
        }
    }
    
    static async processNewData(apiData) {
        if (!apiData) {
            // API fetch failed, but don't stop existing streams
            Logger.log('WARNING', 'API fetch failed, but keeping existing streams running');
            return;
        }
        
        const currentStreams = apiData.data || [];
        const currentTimestamp = apiData.timestamp || new Date().toISOString();
        
        // Handle empty data (0 streams)
        if (currentStreams.length === 0) {
            if (lastApiData && lastApiData.data && lastApiData.data.length > 0) {
                Logger.log('INFO', 'API returned 0 streams (all streams removed)');
                Logger.sendToTelegram('📭 All streams removed from API', null, 'streamStopped');
            }
            
            // Stop all active streams if API says there are none
            if (activeStreams.size > 0) {
                Logger.log('INFO', 'Stopping all streams (API returned empty)');
                activeStreams.forEach((stream, id) => {
                    FFmpegManager.stopStream(id, 'API returned empty data');
                });
            }
            
            lastApiData = apiData;
            return;
        }
        
        // Check if this is the first run
        if (!lastApiData) {
            Logger.log('INFO', `Initial API: ${currentStreams.length} streams found`);
            lastApiData = apiData;
            
            // Start initial streams
            currentStreams.forEach(stream => {
                if (stream.status === 'active') {
                    FFmpegManager.startStream(stream);
                }
            });
            return;
        }
        
        // Detect changes
        const changes = this.detectChanges(lastApiData.data, currentStreams);
        
        // Only log if there are actual changes
        if (changes.added.length > 0 || changes.removed.length > 0 || changes.updated.length > 0) {
            Logger.log('INFO', `Changes: +${changes.added.length} -${changes.removed.length} ~${changes.updated.length}`);
            
            // Process changes
            await this.handleChanges(changes, currentStreams);
        }
        
        lastApiData = apiData;
    }
    
    static detectChanges(oldStreams, newStreams) {
        const changes = { added: [], removed: [], updated: [] };
        
        // Handle case where oldStreams might be undefined
        oldStreams = oldStreams || [];
        
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
        
        // Find updated streams (only status or source changes)
        for (const [id, newStream] of newMap) {
            const oldStream = oldMap.get(id);
            if (oldStream) {
                // Check if important fields changed
                if (newStream.status !== oldStream.status ||
                    newStream.rtmps_url !== oldStream.rtmps_url ||
                    newStream.rtmp_source !== oldStream.rtmp_source) {
                    changes.updated.push(newStream);
                }
            }
        }
        
        return changes;
    }
    
    static async handleChanges(changes, allStreams) {
        // Handle removed streams
        for (const removedStream of changes.removed) {
            if (activeStreams.has(removedStream.id)) {
                Logger.log('INFO', `Stream ${removedStream.name} removed from API`, removedStream.id);
                FFmpegManager.stopStream(removedStream.id, 'Removed from API');
                Logger.sendToTelegram(`🗑️ Stream removed: ${removedStream.name}`, removedStream.id, 'streamStopped');
            }
        }
        
        // Handle added streams
        for (const addedStream of changes.added) {
            if (addedStream.status === 'active') {
                Logger.log('INFO', `New stream detected: ${addedStream.name}`, addedStream.id);
                FFmpegManager.startStream(addedStream);
                Logger.sendToTelegram(`🆕 New stream: ${addedStream.name}`, addedStream.id, 'newStream');
            }
        }
        
        // Handle updated streams
        for (const updatedStream of changes.updated) {
            const wasActive = activeStreams.has(updatedStream.id);
            const nowActive = updatedStream.status === 'active';
            
            if (wasActive && !nowActive) {
                Logger.log('INFO', `Stream ${updatedStream.name} marked inactive`, updatedStream.id);
                FFmpegManager.stopStream(updatedStream.id, 'Marked inactive');
                Logger.sendToTelegram(`⏸️ Stream inactive: ${updatedStream.name}`, updatedStream.id, 'streamStopped');
            } else if (!wasActive && nowActive) {
                Logger.log('INFO', `Stream ${updatedStream.name} marked active`, updatedStream.id);
                FFmpegManager.startStream(updatedStream);
                Logger.sendToTelegram(`▶️ Stream active: ${updatedStream.name}`, updatedStream.id, 'newStream');
            } else if (wasActive && nowActive) {
                // Check if source changed
                const current = activeStreams.get(updatedStream.id);
                if (current && 
                    (current.info.rtmps_url !== updatedStream.rtmps_url ||
                     current.info.rtmp_source !== updatedStream.rtmp_source)) {
                    
                    Logger.log('INFO', `Stream ${updatedStream.name} source modified`, updatedStream.id);
                    FFmpegManager.stopStream(updatedStream.id, 'Source modified');
                    setTimeout(() => {
                        FFmpegManager.startStream(updatedStream);
                    }, 2000);
                    Logger.sendToTelegram(`✏️ Stream modified: ${updatedStream.name}`, updatedStream.id, 'streamModified');
                }
            }
        }
    }
}

// ================== INDEPENDENT STREAM MANAGER ==================
class FFmpegManager {
    static startStream(streamInfo) {
        const { id, name, rtmps_url, rtmp_source } = streamInfo;
        
        // Validate URLs
        if (!rtmps_url || rtmps_url.length < 10) {
            Logger.log('ERROR', `Invalid RTMPS URL for ${name}`, id);
            return null;
        }
        
        if (!rtmp_source || rtmp_source.length < 5) {
            Logger.log('ERROR', `Invalid source URL for ${name}`, id);
            return null;
        }
        
        Logger.log('INFO', `Starting: ${name}`, id);
        
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
        
        // Store stream info
        const streamData = {
            process: ffmpeg,
            info: streamInfo,
            startTime: new Date(),
            restartCount: 0,
            lastError: null
        };
        
        activeStreams.set(id, streamData);
        
        // FFmpeg event handlers
        ffmpeg.stderr.on('data', (data) => {
            const message = data.toString();
            
            // Only log important FFmpeg messages
            if (message.includes('error') || message.includes('fail')) {
                Logger.log('ERROR', `FFmpeg: ${message.substring(0, 100)}`, id);
                streamData.lastError = message.substring(0, 200);
                
                if (CONFIG.telegram.alertOn.ffmpegError) {
                    Logger.sendToTelegram(`🔴 FFmpeg error in ${name}: ${message.substring(0, 100)}`, id, 'ffmpegError');
                }
            }
        });
        
        ffmpeg.on('close', (code) => {
            Logger.log('WARNING', `FFmpeg exited with code ${code}`, id);
            activeStreams.delete(id);
            
            // Auto-restart logic (optional)
            if (code !== 0 && streamData.restartCount < 3) {
                streamData.restartCount++;
                Logger.log('INFO', `Auto-restarting ${name} (attempt ${streamData.restartCount})`, id);
                setTimeout(() => {
                    if (lastApiData?.data?.find(s => s.id === id && s.status === 'active')) {
                        FFmpegManager.startStream(streamInfo);
                    }
                }, 5000);
            }
        });
        
        return ffmpeg;
    }
    
    static stopStream(streamId, reason = 'Manual stop') {
        const stream = activeStreams.get(streamId);
        
        if (!stream) {
            return false;
        }
        
        Logger.log('INFO', `Stopping: ${stream.info.name} (${reason})`, streamId);
        
        try {
            stream.process.kill('SIGTERM');
        } catch (error) {
            Logger.log('WARNING', `Error stopping process: ${error.message}`, streamId);
        }
        
        activeStreams.delete(streamId);
        return true;
    }
    
    static checkStreamHealth() {
        let issues = [];
        
        activeStreams.forEach((stream, id) => {
            if (stream.process.exitCode !== null) {
                issues.push(`${stream.info.name} (ID: ${id}) process died`);
                activeStreams.delete(id);
            }
        });
        
        if (issues.length > 0) {
            Logger.log('WARNING', `Health check: ${issues.length} dead streams`);
            if (CONFIG.telegram.alertOn.ffmpegError) {
                Logger.sendToTelegram(`⚠️ Dead streams detected: ${issues.join(', ')}`, null, 'ffmpegError');
            }
        }
        
        return issues;
    }
}

// ================== MAIN MONITORING LOOP ==================
async function monitoringLoop() {
    try {
        // Fetch API data
        const apiData = await APIMonitor.fetchStreamData();
        
        // Process data (handles empty data gracefully)
        await APIMonitor.processNewData(apiData);
        
        // Health check (less frequent)
        if (Date.now() % 120000 < CONFIG.api.pollInterval) { // Every 2 minutes
            FFmpegManager.checkStreamHealth();
        }
        
    } catch (error) {
        // This shouldn't happen with our error handling, but just in case
        Logger.log('ERROR', `Unexpected error in monitoring loop: ${error.message}`);
    }
}

// ================== MAIN APPLICATION ==================
async function main() {
    console.log('\n' + '🚀'.repeat(30));
    console.log('ENHANCED STREAM MONITOR');
    console.log('Starting with improved error handling');
    console.log('🚀'.repeat(30) + '\n');
    
    Logger.sendToTelegram('🚀 Enhanced Stream Monitor Started', null);
    
    // Initial API fetch
    Logger.log('INFO', 'Performing initial API fetch...');
    const initialData = await APIMonitor.fetchStreamData();
    await APIMonitor.processNewData(initialData);
    
    // Start monitoring interval
    const monitorInterval = setInterval(monitoringLoop, CONFIG.api.pollInterval);
    
    // Graceful shutdown
    process.on('SIGINT', async () => {
        clearInterval(monitorInterval);
        
        console.log('\n' + '🛑'.repeat(30));
        console.log('GRACEFUL SHUTDOWN');
        console.log('🛑'.repeat(30));
        
        Logger.log('INFO', 'Server shutting down');
        Logger.sendToTelegram('🛑 Stream Monitor Shutting Down', null);
        
        let stopped = 0;
        activeStreams.forEach((stream, id) => {
            stream.process.kill('SIGTERM');
            stopped++;
        });
        
        console.log(`\n✅ Stopped ${stopped} streams`);
        console.log('📝 Logs: ' + CONFIG.logging.logFile);
        console.log('\n👋 Goodbye!\n');
        
        process.exit(0);
    });
    
    // Keep running
    await new Promise(() => {});
}

// ================== STARTUP ==================
if (CONFIG.telegram.botToken && CONFIG.telegram.botToken !== "YOUR_TELEGRAM_BOT_TOKEN") {
    main().catch(error => {
        console.error('Fatal error:', error);
        process.exit(1);
    });
} else {
    console.log('⚠️ Telegram not configured, running without notifications\n');
    CONFIG.telegram.enabled = false;
    main().catch(console.error);
}
