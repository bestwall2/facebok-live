// ================== IMPORTS ==================
import { spawn } from 'child_process';
import { writeFileSync, appendFileSync } from 'fs';

// ================== CONFIGURATION ==================
const CONFIG = {
    api: {
        url: "https://ani-box-nine.vercel.app/api/grok-chat",
        pollInterval: 30000  // Check every 30 seconds
    },
    telegram: {
        botToken: "7971806903:AAHwpdNzkk6ClL3O17JVxZnp5e9uI66L9WE",
        chatId: "5806630118",
        enabled: true,
        alerts: {
            newStream: true,
            stoppedStream: true,
            streamError: true,
            apiError: true
        }
    }
};

// ================== GLOBAL STATE ==================
let activeStreams = new Map();  // id -> {process, info, startTime}
let lastTelegramAlert = new Map(); // id -> last alert time

// ================== TELEGRAM BOT ==================
class TelegramBot {
    static async sendMessage(message) {
        if (!CONFIG.telegram.enabled) return;
        
        try {
            const url = `https://api.telegram.org/bot${CONFIG.telegram.botToken}/sendMessage`;
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: CONFIG.telegram.chatId,
                    text: message,
                    parse_mode: 'HTML'
                })
            });
            
            if (!response.ok) {
                const error = await response.text();
                console.error('Telegram API error:', error);
            }
        } catch (error) {
            console.error('Telegram send failed:', error.message);
        }
    }
    
    static async sendAlert(streamId, message, type = 'info') {
        if (!CONFIG.telegram.enabled) return;
        if (!CONFIG.telegram.alerts[type]) return;
        
        // Prevent spam: only send same alert every 5 minutes
        const now = Date.now();
        const lastAlert = lastTelegramAlert.get(streamId) || 0;
        const alertKey = `${streamId}-${type}`;
        
        if (now - lastAlert < 300000) { // 5 minutes
            return;
        }
        
        await this.sendMessage(message);
        lastTelegramAlert.set(alertKey, now);
    }
}

// ================== SIMPLE LOGGER ==================
class Logger {
    static log(level, message, streamId = null) {
        const timestamp = new Date().toLocaleTimeString();
        const logEntry = `[${timestamp}] ${level}${streamId ? ` [${streamId}]` : ''}: ${message}`;
        
        // Always show in console
        console.log(logEntry);
        
        // Log to file
        try {
            appendFileSync('streams.log', logEntry + '\n');
        } catch (e) {
            console.error('Log file error:', e.message);
        }
    }
}

// ================== FFMPEG STREAM MANAGER ==================
class StreamManager {
    static startStream(streamInfo) {
        const { id, name, rtmps_url, rtmp_source } = streamInfo;
        
        Logger.log('🚀 START', `Starting: ${name}`, id);
        TelegramBot.sendAlert(id, `🚀 <b>STARTING STREAM</b>\nName: ${name}\nID: ${id}`, 'newStream');
        
        
        
        // Robust FFmpeg command with encoding
        const ffmpeg = spawn("ffmpeg", [   
            "-re", 
            "-i", rtmp_source,          // Input source URL
            "-c", "copy",             // Copy codec (no re-encoding)
            "-f", "flv",              // Output format
            rtmps_url   
            
                 
        ]);
        
        // Store stream info
        const streamData = {
            process: ffmpeg,
            info: streamInfo,
            startTime: Date.now(),
            restartCount: 0,
            isRunning: true
        };
        
        activeStreams.set(id, streamData);
        
        // Handle FFmpeg output
        ffmpeg.stderr.on('data', (data) => {
            const msg = data.toString();
            
            // Show connection success
            if (msg.includes('Opening') && msg.includes('output')) {
                Logger.log('✅ SUCCESS', `Connected to Facebook`, id);
            }
            
            // Show streaming progress
            if (msg.includes('frame=') && msg.includes('fps=')) {
                const frameMatch = msg.match(/frame=\s*(\d+)/);
                const timeMatch = msg.match(/time=([\d:.]+)/);
                if (frameMatch && parseInt(frameMatch[1]) % 100 === 0) {
                    Logger.log('📊 PROGRESS', `Frame ${frameMatch[1]}, Time ${timeMatch ? timeMatch[1] : 'N/A'}`, id);
                }
            }
            
            // Show errors
            if (msg.includes('error') || msg.includes('fail') || msg.includes('Invalid')) {
                const errorMsg = msg.substring(0, 150);
                Logger.log('❌ ERROR', `FFmpeg: ${errorMsg}`, id);
                TelegramBot.sendAlert(id, `❌ <b>FFMPEG ERROR</b>\nStream: ${name}\nError: ${errorMsg}`, 'streamError');
            }
        });
        
        ffmpeg.on('close', (code) => {
            const stream = activeStreams.get(id);
            if (stream) {
                stream.isRunning = false;
            }
            
            Logger.log('🛑 STOP', `Stopped with code ${code}`, id);
            
            if (code !== 0) {
                TelegramBot.sendAlert(id, `🛑 <b>STREAM STOPPED</b>\nName: ${name}\nCode: ${code}`, 'streamError');
            }
            
            // Auto-restart logic
            if (stream && code !== 0 && stream.restartCount < 3) {
                stream.restartCount++;
                Logger.log('🔄 RESTART', `Attempt ${stream.restartCount}/3 in 10 seconds`, id);
                
                setTimeout(() => {
                    if (activeStreams.get(id)?.isRunning === false) {
                        Logger.log('🔄 RESTART', `Executing restart...`, id);
                        StreamManager.startStream(streamInfo);
                    }
                }, 10000);
            } else {
                activeStreams.delete(id);
            }
        });
        
        ffmpeg.on('error', (error) => {
            Logger.log('💥 FATAL', `FFmpeg process error: ${error.message}`, id);
            TelegramBot.sendAlert(id, `💥 <b>PROCESS ERROR</b>\nStream: ${name}\nError: ${error.message}`, 'streamError');
            activeStreams.delete(id);
        });
        
        return ffmpeg;
    }
    
    static stopStream(id, reason = "API removed") {
        const stream = activeStreams.get(id);
        if (!stream) return false;
        
        Logger.log('🛑 STOP', `Manual stop: ${stream.info.name} (${reason})`, id);
        TelegramBot.sendAlert(id, `🛑 <b>MANUAL STOP</b>\nStream: ${stream.info.name}\nReason: ${reason}`, 'stoppedStream');
        
        stream.isRunning = false;
        
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
    
    static getStatus() {
        const status = [];
        activeStreams.forEach((stream, id) => {
            const uptime = Math.floor((Date.now() - stream.startTime) / 1000);
            const mins = Math.floor(uptime / 60);
            const secs = uptime % 60;
            status.push({
                id,
                name: stream.info.name,
                uptime: `${mins}m ${secs}s`,
                running: stream.isRunning,
                restartCount: stream.restartCount
            });
        });
        return status;
    }
}

// ================== API MONITOR ==================
class APIMonitor {
    static async fetchStreams() {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000);
            
            const response = await fetch(CONFIG.api.url, {
                headers: {
                    'User-Agent': 'StreamMonitor/1.0',
                    'Accept': 'application/json'
                },
                signal: controller.signal
            });
            
            clearTimeout(timeout);
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            
            const data = await response.json();
            const apiData = data.data || data;
            
            if (!apiData.success) {
                throw new Error('API returned success: false');
            }
            
            return apiData.data || [];
            
        } catch (error) {
            Logger.log('🌐 API ERROR', `Failed: ${error.message}`);
            TelegramBot.sendAlert('system', `🌐 <b>API ERROR</b>\n${error.message}`, 'apiError');
            return [];
        }
    }
    
    static async monitor() {
        try {
            const streams = await this.fetchStreams();
            
            if (streams.length === 0) {
                Logger.log('ℹ️ INFO', 'API returned 0 streams');
                
                // If API returns empty but we have active streams
                if (activeStreams.size > 0) {
                    Logger.log('⚠️ WARNING', `API says 0 streams but we have ${activeStreams.size} active`);
                }
                return;
            }
            
            Logger.log('📡 API', `Found ${streams.length} streams`);
            
            // Track current streams
            const apiStreamIds = new Set();
            
            // Process each stream from API
            for (const stream of streams) {
                apiStreamIds.add(stream.id);
                
                if (stream.status === 'active') {
                    const isRunning = activeStreams.has(stream.id);
                    
                    if (!isRunning) {
                        // New active stream
                        Logger.log('🆕 NEW', `Starting: ${stream.name}`, stream.id);
                        StreamManager.startStream(stream);
                    } else {
                        // Stream already running, check if needs update
                        const runningStream = activeStreams.get(stream.id);
                        if (runningStream && 
                            (runningStream.info.rtmps_url !== stream.rtmps_url || 
                             runningStream.info.rtmp_source !== stream.rtmp_source)) {
                            Logger.log('🔄 UPDATE', `Restarting ${stream.name} (source changed)`, stream.id);
                            StreamManager.stopStream(stream.id, "Source updated");
                            setTimeout(() => StreamManager.startStream(stream), 2000);
                        }
                    }
                } else if (stream.status !== 'active' && activeStreams.has(stream.id)) {
                    // Stream became inactive
                    Logger.log('⏸️ INACTIVE', `Stopping: ${stream.name}`, stream.id);
                    StreamManager.stopStream(stream.id, "Marked inactive");
                }
            }
            
            // Stop streams not in API anymore
            activeStreams.forEach((stream, id) => {
                if (!apiStreamIds.has(id)) {
                    Logger.log('🗑️ REMOVED', `Stopping: ${stream.info.name} (not in API)`, id);
                    StreamManager.stopStream(id, "Removed from API");
                }
            });
            
            // Show status
            const activeStatus = StreamManager.getStatus();
            if (activeStatus.length > 0) {
                Logger.log('📊 STATUS', `${activeStatus.length} active streams:`);
                activeStatus.forEach(s => {
                    Logger.log('   📺', `${s.name} - ${s.uptime} (restarts: ${s.restartCount})`, s.id);
                });
            } else {
                Logger.log('📊 STATUS', 'No active streams');
            }
            
        } catch (error) {
            Logger.log('💥 MONITOR ERROR', error.message);
        }
    }
}

// ================== MAIN APPLICATION ==================
async function main() {
    console.log('\n' + '='.repeat(60));
    console.log('📡 FACEBOOK STREAM MONITOR');
    console.log(`🌐 API: ${CONFIG.api.url}`);
    console.log(`🤖 Telegram: ${CONFIG.telegram.enabled ? 'Enabled' : 'Disabled'}`);
    console.log('='.repeat(60));
    console.log('Starting at:', new Date().toLocaleString());
    console.log('='.repeat(60) + '\n');
    
    // Initialize log file
    try {
        writeFileSync('streams.log', '=== STREAM MONITOR LOG ===\n');
        appendFileSync('streams.log', `Started: ${new Date().toLocaleString()}\n`);
        appendFileSync('streams.log', '='.repeat(50) + '\n');
    } catch (e) {
        console.error('Log init failed:', e.message);
    }
    
    // Send startup notification
    if (CONFIG.telegram.enabled) {
        await TelegramBot.sendMessage('🚀 <b>STREAM MONITOR STARTED</b>\n' + 
                                     `Time: ${new Date().toLocaleString()}\n` +
                                     `API: ${CONFIG.api.url}`);
    }
    
    // Initial API check
    Logger.log('🔧 INIT', 'Performing initial API check...');
    await APIMonitor.monitor();
    
    // Start monitoring loop
    let monitorInterval;
    const startMonitoring = () => {
        if (monitorInterval) clearInterval(monitorInterval);
        monitorInterval = setInterval(async () => {
            try {
                await APIMonitor.monitor();
            } catch (error) {
                Logger.log('💥 INTERVAL ERROR', error.message);
            }
        }, CONFIG.api.pollInterval);
    };
    
    startMonitoring();
    
    // Health check: restart monitoring if it stops
    setInterval(() => {
        if (!monitorInterval) {
            Logger.log('⚠️ HEALTH', 'Monitoring stopped, restarting...');
            startMonitoring();
        }
    }, 60000);
    
    // Graceful shutdown handler
    process.on('SIGINT', async () => {
        console.log('\n' + '🛑'.repeat(30));
        console.log('GRACEFUL SHUTDOWN INITIATED');
        console.log('🛑'.repeat(30));
        
        if (monitorInterval) clearInterval(monitorInterval);
        
        Logger.log('🔧 SHUTDOWN', 'Stopping all streams...');
        
        if (CONFIG.telegram.enabled) {
            await TelegramBot.sendMessage('🛑 <b>MONITOR SHUTTING DOWN</b>\n' +
                                         `Active streams: ${activeStreams.size}\n` +
                                         `Time: ${new Date().toLocaleString()}`);
        }
        
        const stoppedCount = StreamManager.stopAll();
        
        console.log(`\n✅ Stopped ${stoppedCount} streams`);
        console.log('📝 Logs saved to: streams.log');
        console.log('\n👋 Goodbye!\n');
        
        // Add shutdown to log
        appendFileSync('streams.log', `\nShutdown: ${new Date().toLocaleString()}\n`);
        
        process.exit(0);
    });
    
    // Keep application running
    console.log('\n✅ Monitor is running. Press Ctrl+C to stop.\n');
    
    // Display status every 5 minutes
    setInterval(() => {
        const status = StreamManager.getStatus();
        console.log('\n' + '📊'.repeat(30));
        console.log('5-MINUTE STATUS');
        console.log(`Active streams: ${status.length}`);
        
        if (status.length > 0) {
            status.forEach(s => {
                console.log(`  ${s.name} - ${s.uptime}`);
            });
        } else {
            console.log('  No active streams');
        }
        console.log('📊'.repeat(30) + '\n');
    }, 300000);
    
    // Keep process alive
    while (true) {
        await new Promise(resolve => setTimeout(resolve, 60000));
    }
}

// ================== STARTUP ==================
// Create package.json if it doesn't exist
try {
    const fs = await import('fs');
    if (!fs.existsSync('package.json')) {
        fs.writeFileSync('package.json', JSON.stringify({
            "type": "module",
            "name": "facebook-stream-monitor",
            "version": "1.0.0"
        }, null, 2));
        console.log('✅ Created package.json');
    }
} catch (e) {
    // Continue anyway
}

// Start the application
main().catch(error => {
    console.error('\n💥 FATAL STARTUP ERROR:', error);
    console.error('Stack:', error.stack);
    
    if (CONFIG.telegram.enabled) {
        TelegramBot.sendMessage(`💥 <b>MONITOR CRASHED</b>\nError: ${error.message}\nTime: ${new Date().toLocaleString()}`)
            .catch(() => {});
    }
    
    process.exit(1);
});
