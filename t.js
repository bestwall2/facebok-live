// ================== IMPORTS ==================
import { spawn } from 'child_process';
import { writeFileSync, appendFileSync } from 'fs';
import { setTimeout } from 'timers/promises';

// ================== CONFIGURATION ==================
const CONFIG = {
    api: {
        url: "https://ani-box-nine.vercel.app/api/grok-chat",
        pollInterval: 30000,  // Check every 30 seconds
        retryDelay: 10000
    },
    telegram: {
        botToken: "7971806903:AAHwpdNzkk6ClL3O17JVxZnp5e9uI66L9WE",  // Get from @BotFather
        chatId: "5806630118",
        enabled: false,
        alerts: {
            newStream: true,
            stoppedStream: true,
            streamError: true,
            apiError: false
        }
    },
    logging: {
        logFile: "streams.log",
        statusReportInterval: 300000
    }
};

// ================== GLOBAL STATE ==================
let activeStreams = new Map();
let lastStatusReport = Date.now();
let apiErrorCount = 0;

// ================== SIMPLE LOGGER ==================
class Logger {
    static log(level, message, streamId = null) {
        const timestamp = new Date().toLocaleTimeString();
        const logEntry = `[${timestamp}] ${level}${streamId ? ` [${streamId}]` : ''}: ${message}`;
        
        // Console - only important messages
        const showInConsole = level === 'ERROR' || level === 'START' || level === 'STOP' || 
                             level === 'NEW' || level === 'STATUS';
        
        if (showInConsole) {
            const colors = {
                'START': '\x1b[32m',
                'STOP': '\x1b[33m',
                'NEW': '\x1b[36m',
                'ERROR': '\x1b[31m',
                'STATUS': '\x1b[35m',
                'INFO': '\x1b[90m'
            };
            console.log(`${colors[level] || ''}${logEntry}\x1b[0m`);
        }
        
        // File logging
        try {
            appendFileSync(CONFIG.logging.logFile, logEntry + '\n');
        } catch (e) {
            console.error('Log file error:', e.message);
        }
        
        // 5-minute status report
        const now = Date.now();
        if (now - lastStatusReport >= CONFIG.logging.statusReportInterval) {
            this.showStatusReport();
            lastStatusReport = now;
        }
    }
    
    static showStatusReport() {
        console.log('\n' + '📊'.repeat(40));
        console.log('5-MINUTE STATUS REPORT');
        console.log(`Active streams: ${activeStreams.size}`);
        console.log(`API errors: ${apiErrorCount}`);
        
        if (activeStreams.size > 0) {
            console.log('\n🎥 ACTIVE STREAMS:');
            activeStreams.forEach((stream, id) => {
                const uptime = Math.floor((Date.now() - stream.startTime) / 1000);
                const mins = Math.floor(uptime / 60);
                const secs = uptime % 60;
                console.log(`  ${stream.info.name} - ${mins}m ${secs}s`);
            });
        }
        
        console.log('📊'.repeat(40) + '\n');
        
        // Send Telegram status if enabled
        if (CONFIG.telegram.enabled) {
            this.sendTelegram(`📊 Status: ${activeStreams.size} streams active`, 'STATUS');
        }
    }
    
    static async sendTelegram(message, alertType = null) {
        if (!CONFIG.telegram.enabled || !CONFIG.telegram.botToken || !CONFIG.telegram.chatId) return;
        if (alertType && !CONFIG.telegram.alerts[alertType]) return;
        
        try {
            const response = await fetch(`https://api.telegram.org/bot${CONFIG.telegram.botToken}/sendMessage`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    chat_id: CONFIG.telegram.chatId,
                    text: message,
                    parse_mode: 'HTML'
                })
            });
            return response.ok;
        } catch (error) {
            console.log('Telegram error:', error.message);
        }
    }
}

// ================== FFMPEG STREAM MANAGER ==================
class StreamManager {
    static startStream(streamInfo) {
        const { id, name, rtmps_url, rtmp_source } = streamInfo;
        
        Logger.log('START', `Starting: ${name}`, id);
        
        if (CONFIG.telegram.enabled) {
            Logger.sendTelegram(`🟢 STARTING: ${name}`, 'newStream');
        }
        
        // Simple FFmpeg command
        const ffmpeg = spawn("ffmpeg", [
            "-re",
            "-i", rtmp_source,
            "-c", "copy",
            "-f", "flv",
            rtmps_url
        ]);
        
        // Store stream info
        const streamData = {
            process: ffmpeg,
            info: streamInfo,
            startTime: Date.now(),
            restartCount: 0
        };
        
        activeStreams.set(id, streamData);
        
        // Handle FFmpeg output
        ffmpeg.stderr.on('data', (data) => {
            const msg = data.toString();
            
            // Show connection success
            if (msg.includes('Opening') && msg.includes('output')) {
                Logger.log('INFO', `Connected to Facebook`, id);
            }
            
            // Show errors
            if (msg.includes('error') || msg.includes('fail') || msg.includes('Invalid')) {
                const errorMsg = msg.substring(0, 100);
                Logger.log('ERROR', `FFmpeg: ${errorMsg}`, id);
                if (CONFIG.telegram.enabled) {
                    Logger.sendTelegram(`🔴 ERROR in ${name}: ${errorMsg}`, 'streamError');
                }
            }
            
            // Show progress (occasionally)
            if (msg.includes('frame=') && Math.random() < 0.05) {
                const frameMatch = msg.match(/frame=\s*(\d+)/);
                const timeMatch = msg.match(/time=([\d:.]+)/);
                if (frameMatch) {
                    Logger.log('INFO', `Frame ${frameMatch[1]}${timeMatch ? `, Time ${timeMatch[1]}` : ''}`, id);
                }
            }
        });
        
        ffmpeg.on('close', (code) => {
            Logger.log('STOP', `Stopped (code: ${code})`, id);
            activeStreams.delete(id);
            
            // Auto-restart logic (max 2 attempts)
            if (code !== 0 && streamData.restartCount < 2) {
                streamData.restartCount++;
                setTimeout(() => {
                    Logger.log('INFO', `Restarting (attempt ${streamData.restartCount})`, id);
                    StreamManager.startStream(streamInfo);
                }, 5000);
            }
        });
        
        return ffmpeg;
    }
    
    static stopStream(id, reason = "API removed") {
        const stream = activeStreams.get(id);
        if (!stream) return false;
        
        Logger.log('STOP', `Stopping: ${stream.info.name} (${reason})`, id);
        
        if (CONFIG.telegram.enabled) {
            Logger.sendTelegram(`🟡 STOPPED: ${stream.info.name}`, 'stoppedStream');
        }
        
        try {
            stream.process.kill('SIGTERM');
        } catch (e) {
            // Process already dead
        }
        
        activeStreams.delete(id);
        return true;
    }
    
    static stopAll() {
        let count = 0;
        activeStreams.forEach((stream, id) => {
            this.stopStream(id, "System shutdown");
            count++;
        });
        return count;
    }
}

// ================== API MONITOR ==================
class APIMonitor {
    static async fetchStreams() {
        try {
            const response = await fetch(CONFIG.api.url, {
                headers: {
                    'User-Agent': 'StreamMonitor/1.0',
                    'Accept': 'application/json'
                },
                // timeout: 15000 (Node 18+ has built-in timeout)
            });
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            
            const data = await response.json();
            
            // Handle nested structure from your API
            const apiData = data.data || data;
            
            if (!apiData.success) {
                throw new Error('API returned success: false');
            }
            
            // Reset error counter on success
            apiErrorCount = 0;
            
            return apiData.data || [];
            
        } catch (error) {
            apiErrorCount++;
            
            // Only log every 5th error to avoid spam
            if (apiErrorCount % 5 === 1) {
                Logger.log('ERROR', `API error ${apiErrorCount}: ${error.message}`);
            }
            
            // Return empty array to keep existing streams running
            return [];
        }
    }
    
    static async monitor() {
        const streams = await this.fetchStreams();
        
        // If API returns data
        if (streams.length > 0) {
            Logger.log('INFO', `API: ${streams.length} streams found`);
            
            // Check for new/removed streams
            const activeIds = new Set(streams.map(s => s.id));
            const currentIds = new Set(activeStreams.keys());
            
            // Stop streams removed from API
            currentIds.forEach(id => {
                if (!activeIds.has(id)) {
                    Logger.log('NEW', `Removed from API`, id);
                    StreamManager.stopStream(id, "Removed from API");
                }
            });
            
            // Start new active streams
            streams.forEach(stream => {
                if (stream.status === 'active' && !activeStreams.has(stream.id)) {
                    Logger.log('NEW', `New stream: ${stream.name}`, stream.id);
                    StreamManager.startStream(stream);
                }
            });
            
        } else if (streams.length === 0) {
            // API returned empty array (no streams)
            Logger.log('INFO', 'API returned 0 streams');
            
            // If we have active streams but API says none, stop them
            if (activeStreams.size > 0) {
                Logger.log('INFO', 'Stopping all streams (API returned empty)');
                StreamManager.stopAll();
            }
        }
        
        // Show current status
        Logger.log('STATUS', `Active: ${activeStreams.size} streams`);
    }
}

// ================== MAIN APPLICATION ==================
async function main() {
    console.log('\n' + '='.repeat(50));
    console.log('📡 STREAM MONITOR STARTING');
    console.log(`🌐 API: ${CONFIG.api.url}`);
    console.log('='.repeat(50) + '\n');
    
    // Create log file if it doesn't exist
    try {
        writeFileSync(CONFIG.logging.logFile, 'Stream Monitor Log\n' + '='.repeat(50) + '\n');
    } catch (e) {
        console.error('Could not create log file:', e.message);
    }
    
    // Initial Telegram notification
    if (CONFIG.telegram.enabled) {
        await Logger.sendTelegram('🚀 Stream Monitor Started', 'newStream');
    }
    
    // Initial API check
    Logger.log('INFO', 'Performing initial API check...');
    await APIMonitor.monitor();
    
    // Start monitoring loop
    const monitorInterval = setInterval(async () => {
        try {
            await APIMonitor.monitor();
        } catch (error) {
            console.error('Monitoring error:', error.message);
        }
    }, CONFIG.api.pollInterval);
    
    // Graceful shutdown
    process.on('SIGINT', () => {
        clearInterval(monitorInterval);
        
        console.log('\n' + '🛑'.repeat(25));
        console.log('SHUTDOWN INITIATED');
        console.log('🛑'.repeat(25));
        
        const stopped = StreamManager.stopAll();
        
        if (CONFIG.telegram.enabled) {
            Logger.sendTelegram(`🛑 Monitor stopped. ${stopped} streams terminated.`);
        }
        
        console.log(`\n✅ Stopped ${stopped} streams`);
        console.log('📝 Logs saved to:', CONFIG.logging.logFile);
        console.log('\n👋 Goodbye!\n');
        
        process.exit(0);
    });
    
    // Keep running
    while (true) {
        await setTimeout(60000); // Sleep for 1 minute
    }
}

// ================== START THE APPLICATION ==================
// Make sure you have this package.json:
/*
{
  "type": "module",
  "name": "stream-monitor",
  "version": "1.0.0"
}
*/

main().catch(error => {
    console.error('💥 Fatal error:', error);
    process.exit(1);
});
