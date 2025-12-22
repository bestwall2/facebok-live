
import { spawn } from 'child_process';
import mysql from 'mysql2/promise';
import fs from 'fs';

// ================== DATABASE CONFIGURATION ==================
const DB_CONFIG = {
    host: '185.27.134.129',
    user: 'if0_40726410',
    password: 'ZXjyL4seV5O',
    database: 'if0_40726410_streams',
    connectionLimit: 10,
    waitForConnections: true,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0
};

// ================== TELEGRAM CONFIG ==================
const TELEGRAM = {
    botToken: "7971806903:AAHwpdNzkk6ClL3O17JVxZnp5e9uI66L9WE",  // Get from @BotFather
    chatId: "5806630118",
    enabled: true,
    alerts: {
        newStream: true,
        streamStopped: true,
        streamModified: true,
        ffmpegError: true
    }
};

// ================== GLOBAL STATE ==================
let activeStreams = new Map(); // Map<id, {process, info}>
let dbConnection = null;
let lastPollTime = Date.now();
let statusReportInterval = 300000; // 5 minutes
let lastStatusReport = Date.now();

// ================== LOGGER ==================
class Logger {
    static log(level, message, streamId = null) {
        const timestamp = new Date().toLocaleString();
        const logEntry = `[${timestamp}] [${level}] ${streamId ? `[${streamId}] ` : ''}${message}`;
        
        // Console logging (only important messages)
        const showInConsole = level === 'ERROR' || level === 'WARNING' || 
                            (level === 'INFO' && (message.includes('Starting') || message.includes('Stopping') || 
                             message.includes('Status Report') || message.includes('New stream') ||
                             message.includes('removed') || message.includes('modified')));
        
        if (showInConsole) {
            const colors = { INFO: '\x1b[36m', SUCCESS: '\x1b[32m', WARNING: '\x1b[33m', ERROR: '\x1b[31m' };
            console.log(`${colors[level] || ''}${logEntry}\x1b[0m`);
        }
        
        // File logging
        fs.appendFileSync('stream_monitor.log', logEntry + '\n');
        
        // Status report every 5 minutes
        const now = Date.now();
        if (now - lastStatusReport >= statusReportInterval) {
            this.logStatusReport();
            lastStatusReport = now;
        }
    }
    
    static logStatusReport() {
        console.log('\n' + '📊'.repeat(40));
        console.log('STATUS REPORT - ' + new Date().toLocaleString());
        console.log(`Active streams: ${activeStreams.size}`);
        
        if (activeStreams.size > 0) {
            console.log('\n📺 ACTIVE STREAMS:');
            activeStreams.forEach((stream, id) => {
                const uptime = Math.floor((Date.now() - stream.startTime) / 1000);
                const hours = Math.floor(uptime / 3600);
                const minutes = Math.floor((uptime % 3600) / 60);
                const seconds = uptime % 60;
                console.log(`  ${stream.info.name} (ID: ${id}) - Uptime: ${hours}h ${minutes}m ${seconds}s`);
            });
        }
        
        console.log('📊'.repeat(40) + '\n');
    }
    
    static async sendTelegram(message, streamId = null, alertType = null) {
        if (!TELEGRAM.enabled || !alertType || !TELEGRAM.alerts[alertType]) return;
        
        try {
            const url = `https://api.telegram.org/bot${TELEGRAM.botToken}/sendMessage`;
            const fullMessage = streamId ? `[${streamId}] ${message}` : message;
            
            await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: TELEGRAM.chatId,
                    text: fullMessage,
                    parse_mode: 'HTML'
                })
            });
        } catch (error) {
            console.error('Telegram error:', error.message);
        }
    }
}

// ================== DATABASE MANAGER ==================
class DatabaseManager {
    static async connect() {
        try {
            dbConnection = await mysql.createConnection(DB_CONFIG);
            Logger.log('INFO', '✅ Database connected successfully');
            return true;
        } catch (error) {
            Logger.log('ERROR', `Database connection failed: ${error.message}`);
            return false;
        }
    }
    
    static async disconnect() {
        if (dbConnection) {
            await dbConnection.end();
            Logger.log('INFO', 'Database disconnected');
        }
    }
    
    static async getAllStreams() {
        if (!dbConnection) {
            Logger.log('ERROR', 'No database connection');
            return [];
        }
        
        try {
            const [rows] = await dbConnection.execute(`
                SELECT id, name, rtmps_url, rtmp_source, stream_time, status, created_at, updated_at
                FROM streams 
                WHERE status != 'deleted'
                ORDER BY id DESC
            `);
            
            return rows;
        } catch (error) {
            Logger.log('ERROR', `Database query failed: ${error.message}`);
            return [];
        }
    }
    
    static async getStreamById(id) {
        if (!dbConnection) return null;
        
        try {
            const [rows] = await dbConnection.execute(
                'SELECT * FROM streams WHERE id = ? AND status != "deleted"',
                [id]
            );
            return rows[0] || null;
        } catch (error) {
            Logger.log('ERROR', `Get stream by ID failed: ${error.message}`);
            return null;
        }
    }
    
    static async updateStreamStatus(id, status) {
        if (!dbConnection) return false;
        
        try {
            await dbConnection.execute(
                'UPDATE streams SET status = ?, updated_at = NOW() WHERE id = ?',
                [status, id]
            );
            Logger.log('INFO', `Updated stream ${id} status to ${status}`, id);
            return true;
        } catch (error) {
            Logger.log('ERROR', `Update stream status failed: ${error.message}`, id);
            return false;
        }
    }
    
    static async logStreamEvent(streamId, eventType, message) {
        if (!dbConnection) return;
        
        try {
            await dbConnection.execute(
                'INSERT INTO stream_logs (stream_id, event_type, message) VALUES (?, ?, ?)',
                [streamId, eventType, message]
            );
        } catch (error) {
            console.error('Log stream event failed:', error.message);
        }
    }
}

// ================== FFMPEG MANAGER ==================
class FFmpegManager {
    static startStream(streamInfo) {
        const { id, name, rtmps_url, rtmp_source } = streamInfo;
        
        Logger.log('INFO', `Starting: ${name}`, id);
        Logger.sendTelegram(`🟢 Starting: ${name}`, id, 'newStream');
        
        const args = [
            "-re", "-i", rtmp_source,
            "-map", "0:v:0", "-map", "0:a:0",
            "-c:v", "libx264", "-preset", "veryfast",
            "-pix_fmt", "yuv420p", "-r", "25", "-g", "50",
            "-b:v", "3000k", "-maxrate", "3000k", "-bufsize", "6000k",
            "-c:a", "aac", "-ar", "44100", "-b:a", "128k", "-ac", "2",
            "-f", "flv", rtmps_url
        ];
        
        const ffmpeg = spawn("ffmpeg", args);
        
        const streamData = {
            process: ffmpeg,
            info: streamInfo,
            startTime: new Date(),
            restartAttempts: 0
        };
        
        activeStreams.set(id, streamData);
        
        // FFmpeg output handling
        ffmpeg.stderr.on('data', (data) => {
            const msg = data.toString();
            if (msg.includes('error') || msg.includes('fail')) {
                Logger.log('ERROR', `FFmpeg: ${msg.substring(0, 100)}`, id);
                Logger.sendTelegram(`🔴 FFmpeg error: ${msg.substring(0, 100)}`, id, 'ffmpegError');
                DatabaseManager.logStreamEvent(id, 'ffmpeg_error', msg.substring(0, 200));
            }
        });
        
        ffmpeg.on('close', (code) => {
            Logger.log('WARNING', `FFmpeg exited with code ${code}`, id);
            activeStreams.delete(id);
            
            // Update database status
            DatabaseManager.updateStreamStatus(id, 'stopped');
            
            // Auto-restart logic (max 3 attempts)
            if (code !== 0 && streamData.restartAttempts < 3) {
                streamData.restartAttempts++;
                setTimeout(async () => {
                    const currentInfo = await DatabaseManager.getStreamById(id);
                    if (currentInfo && currentInfo.status === 'active') {
                        Logger.log('INFO', `Auto-restarting ${name} (attempt ${streamData.restartAttempts})`, id);
                        FFmpegManager.startStream(currentInfo);
                    }
                }, 10000);
            }
        });
        
        // Update database to running
        DatabaseManager.updateStreamStatus(id, 'running');
        DatabaseManager.logStreamEvent(id, 'stream_started', `Stream started successfully`);
        
        return ffmpeg;
    }
    
    static stopStream(streamId, reason = 'Manual stop') {
        const stream = activeStreams.get(streamId);
        if (!stream) return false;
        
        Logger.log('INFO', `Stopping: ${stream.info.name} (${reason})`, streamId);
        Logger.sendTelegram(`🟡 Stopping: ${stream.info.name}`, streamId, 'streamStopped');
        
        try {
            stream.process.kill('SIGTERM');
        } catch (error) {
            Logger.log('WARNING', `Error stopping process: ${error.message}`, streamId);
        }
        
        activeStreams.delete(streamId);
        DatabaseManager.updateStreamStatus(streamId, 'stopped');
        DatabaseManager.logStreamEvent(streamId, 'stream_stopped', reason);
        
        return true;
    }
    
    static stopAllStreams() {
        let count = 0;
        activeStreams.forEach((stream, id) => {
            this.stopStream(id, 'System shutdown');
            count++;
        });
        return count;
    }
}

// ================== STREAM MONITOR ==================
class StreamMonitor {
    static async monitorStreams() {
        if (!dbConnection) {
            Logger.log('ERROR', 'No database connection for monitoring');
            return;
        }
        
        try {
            const dbStreams = await DatabaseManager.getAllStreams();
            Logger.log('INFO', `Database: ${dbStreams.length} streams found`);
            
            // Process active streams from database
            const activeDbStreams = dbStreams.filter(s => s.status === 'active');
            
            // Stop streams that are in our active list but not in database
            activeStreams.forEach((stream, id) => {
                const existsInDb = activeDbStreams.find(s => s.id == id);
                if (!existsInDb) {
                    Logger.log('INFO', `Stream ${stream.info.name} not in database, stopping`, id);
                    FFmpegManager.stopStream(id, 'Removed from database');
                    Logger.sendTelegram(`🗑️ Removed: ${stream.info.name}`, id, 'streamStopped');
                }
            });
            
            // Start or update streams from database
            for (const dbStream of activeDbStreams) {
                const isRunning = activeStreams.has(dbStream.id);
                const runningStream = activeStreams.get(dbStream.id);
                
                if (!isRunning) {
                    // New active stream
                    Logger.log('INFO', `New active stream: ${dbStream.name}`, dbStream.id);
                    FFmpegManager.startStream(dbStream);
                    Logger.sendTelegram(`🆕 New stream: ${dbStream.name}`, dbStream.id, 'newStream');
                } else if (runningStream) {
                    // Check if stream needs restart (source changed)
                    if (runningStream.info.rtmps_url !== dbStream.rtmps_url ||
                        runningStream.info.rtmp_source !== dbStream.rtmp_source) {
                        
                        Logger.log('INFO', `Stream ${dbStream.name} source modified, restarting`, dbStream.id);
                        FFmpegManager.stopStream(dbStream.id, 'Source modified');
                        setTimeout(() => {
                            FFmpegManager.startStream(dbStream);
                        }, 2000);
                        Logger.sendTelegram(`✏️ Modified: ${dbStream.name}`, dbStream.id, 'streamModified');
                    }
                }
            }
            
            // Handle inactive streams in database
            const inactiveDbStreams = dbStreams.filter(s => s.status === 'inactive');
            inactiveDbStreams.forEach(stream => {
                if (activeStreams.has(stream.id)) {
                    Logger.log('INFO', `Stream ${stream.name} marked inactive in DB`, stream.id);
                    FFmpegManager.stopStream(stream.id, 'Marked inactive in database');
                }
            });
            
        } catch (error) {
            Logger.log('ERROR', `Monitor error: ${error.message}`);
        }
    }
    
    static async healthCheck() {
        let deadStreams = [];
        
        activeStreams.forEach((stream, id) => {
            if (stream.process.exitCode !== null) {
                deadStreams.push({ id, name: stream.info.name });
                activeStreams.delete(id);
            }
        });
        
        if (deadStreams.length > 0) {
            Logger.log('WARNING', `Found ${deadStreams.length} dead streams`);
            deadStreams.forEach(stream => {
                Logger.sendTelegram(`💀 Stream died: ${stream.name}`, stream.id, 'ffmpegError');
                DatabaseManager.updateStreamStatus(stream.id, 'error');
            });
        }
        
        return deadStreams;
    }
}

// ================== MAIN APPLICATION ==================
async function main() {
    console.log('\n' + '🚀'.repeat(40));
    console.log('MYSQL STREAM MONITOR SERVER');
    console.log('Database: ' + DB_CONFIG.database);
    console.log('🚀'.repeat(40) + '\n');
    
    // Connect to database
    const dbConnected = await DatabaseManager.connect();
    if (!dbConnected) {
        console.error('❌ Cannot start without database connection');
        process.exit(1);
    }
    
    Logger.sendTelegram('🚀 MySQL Stream Monitor Started');
    
    // Initial load
    Logger.log('INFO', 'Performing initial stream load...');
    await StreamMonitor.monitorStreams();
    
    // Main monitoring loop (every 30 seconds)
    const monitorInterval = setInterval(async () => {
        try {
            await StreamMonitor.monitorStreams();
            
            // Health check every 2 minutes
            if (Date.now() % 120000 < 30000) {
                await StreamMonitor.healthCheck();
            }
            
        } catch (error) {
            Logger.log('ERROR', `Monitoring loop error: ${error.message}`);
        }
    }, 30000);
    
    // Status report every 5 minutes
    const statusInterval = setInterval(() => {
        Logger.log('INFO', '5-minute status check');
        Logger.logStatusReport();
    }, 300000);
    
    // Graceful shutdown
    process.on('SIGINT', async () => {
        clearInterval(monitorInterval);
        clearInterval(statusInterval);
        
        console.log('\n' + '🛑'.repeat(40));
        console.log('GRACEFUL SHUTDOWN');
        console.log('🛑'.repeat(40));
        
        Logger.log('INFO', 'Server shutdown initiated');
        Logger.sendTelegram('🛑 Stream Monitor Shutting Down');
        
        const stoppedCount = FFmpegManager.stopAllStreams();
        await DatabaseManager.disconnect();
        
        console.log(`\n✅ Stopped ${stoppedCount} streams`);
        console.log('📝 Logs saved to: stream_monitor.log');
        console.log('\n👋 Goodbye!\n');
        
        process.exit(0);
    });
    
    // Keep running
    await new Promise(() => {});
}

// ================== STARTUP ==================
// Install required packages first:
// npm install mysql2

if (!TELEGRAM.botToken || TELEGRAM.botToken === "YOUR_TELEGRAM_BOT_TOKEN") {
    console.log('⚠️ Running without Telegram notifications');
    TELEGRAM.enabled = false;
}

main().catch(error => {
    console.error('💥 Fatal error:', error);
    process.exit(1);
});
