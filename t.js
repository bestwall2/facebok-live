// stream-monitor.js
import { spawn } from 'child_process';
import { writeFileSync, appendFileSync } from 'fs';

// ================== CONFIGURATION ==================
const CONFIG = {
    api: {
        url: "https://ani-box-nine.vercel.app/api/grok-chat",
        pollInterval: 30000  // 30 seconds
    },
    telegram: {
        botToken: "7971806903:AAHwpdNzkk6ClL3O17JVxZnp5e9uI66L9WE",
        chatId: "5806630118",
        enabled: true
    }
};

// ================== GLOBAL STATE ==================
let activeStreams = new Map();  // id -> {process, info}

// ================== SIMPLE LOGGER ==================
class Logger {
    static log(message, streamId = null) {
        const timestamp = new Date().toLocaleTimeString();
        const logEntry = `[${timestamp}]${streamId ? ` [${streamId}]` : ''}: ${message}`;
        
        console.log(logEntry);
        
        try {
            appendFileSync('streams.log', logEntry + '\n');
        } catch (e) {
            console.error('Log error:', e.message);
        }
    }
    
    static async sendTelegram(message) {
        if (!CONFIG.telegram.enabled) return;
        
        try {
            const response = await fetch(`https://api.telegram.org/bot${CONFIG.telegram.botToken}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: CONFIG.telegram.chatId,
                    text: message,
                    parse_mode: 'HTML'
                })
            });
            
            if (!response.ok) {
                throw new Error(`Telegram API: ${response.status}`);
            }
        } catch (error) {
            console.error('Telegram error:', error.message);
        }
    }
}

// ================== SIMPLE FFMPEG MANAGER ==================
class StreamManager {
    static startStream(streamInfo) {
        const { id, name, rtmps_url, rtmp_source } = streamInfo;
        
        Logger.log(`🚀 Starting: ${name}`, id);
        
        if (CONFIG.telegram.enabled) {
            Logger.sendTelegram(`🚀 <b>Starting Stream</b>\nName: ${name}\nID: ${id}`);
        }
        
        // SIMPLE FFMPEG COMMAND - Works with multiple streams
        const ffmpeg = spawn("ffmpeg", [
            "-re",                    // Read at native framerate
            "-i", rtmp_source,        // Input source
            "-c", "copy",             // COPY - NO RE-ENCODING
            "-f", "flv",              // Output format
            rtmps_url                 // Use RTMPS directly
        ]);
        
        // Store info
        activeStreams.set(id, {
            process: ffmpeg,
            info: streamInfo
        });
        
        // FFmpeg output handling
        ffmpeg.stderr.on('data', (data) => {
            const msg = data.toString();
            
            // Connection success
            if (msg.includes('Opening') && msg.includes('output')) {
                Logger.log(`✅ Connected to Facebook`, id);
            }
            
            // Errors
            if (msg.includes('error') || msg.includes('fail') || msg.includes('Invalid')) {
                const errorMsg = msg.substring(0, 100);
                Logger.log(`❌ FFmpeg: ${errorMsg}`, id);
                
                if (CONFIG.telegram.enabled) {
                    Logger.sendTelegram(`❌ <b>FFmpeg Error</b>\nStream: ${name}\nError: ${errorMsg}`);
                }
            }
            
            // Progress
            if (msg.includes('frame=') && Math.random() < 0.05) {
                const frameMatch = msg.match(/frame=\s*(\d+)/);
                const timeMatch = msg.match(/time=([\d:.]+)/);
                if (frameMatch && timeMatch) {
                    Logger.log(`📊 Frame ${frameMatch[1]}, Time ${timeMatch[1]}`, id);
                }
            }
        });
        
        ffmpeg.on('close', (code) => {
            Logger.log(`🔴 Stopped (code: ${code})`, id);
            activeStreams.delete(id);
            
            if (code !== 0 && CONFIG.telegram.enabled) {
                Logger.sendTelegram(`🛑 <b>Stream Stopped</b>\nName: ${name}\nCode: ${code}`);
            }
        });
        
        ffmpeg.on('error', (error) => {
            Logger.log(`💥 Process error: ${error.message}`, id);
            activeStreams.delete(id);
        });
        
        return ffmpeg;
    }
    
    static stopStream(id) {
        const stream = activeStreams.get(id);
        if (!stream) return false;
        
        Logger.log(`🛑 Stopping: ${stream.info.name}`, id);
        
        try {
            stream.process.kill('SIGTERM');
        } catch (e) {
            // Already dead
        }
        
        activeStreams.delete(id);
        return true;
    }
    
    static stopAll() {
        let count = 0;
        activeStreams.forEach((stream, id) => {
            this.stopStream(id);
            count++;
        });
        return count;
    }
}

// ================== SIMPLE API MONITOR ==================
class APIMonitor {
    static async fetchStreams() {
        try {
            const response = await fetch(CONFIG.api.url);
            const data = await response.json();
            const apiData = data.data || data;
            
            if (!apiData.success) {
                throw new Error('API success: false');
            }
            
            return apiData.data || [];
            
        } catch (error) {
            Logger.log(`🌐 API error: ${error.message}`);
            return [];
        }
    }
    
    static async monitor() {
        try {
            const streams = await this.fetchStreams();
            
            if (streams.length === 0) {
                Logger.log('API returned 0 streams');
                
                // Stop all if API says no streams
                if (activeStreams.size > 0) {
                    Logger.log('Stopping all streams (API empty)');
                    StreamManager.stopAll();
                }
                return;
            }
            
            Logger.log(`Found ${streams.length} streams in API`);
            
            // Track current IDs
            const apiStreamIds = new Set();
            
            // Start new active streams
            for (const stream of streams) {
                apiStreamIds.add(stream.id);
                
                if (stream.status === 'active' && !activeStreams.has(stream.id)) {
                    Logger.log(`🆕 New active: ${stream.name}`, stream.id);
                    StreamManager.startStream(stream);
                }
            }
            
            // Stop streams not in API
            activeStreams.forEach((stream, id) => {
                if (!apiStreamIds.has(id)) {
                    Logger.log(`🗑️ Removing: ${stream.info.name} (not in API)`, id);
                    StreamManager.stopStream(id);
                }
            });
            
            // Show status
            this.showStatus();
            
        } catch (error) {
            Logger.log(`Monitor error: ${error.message}`);
        }
    }
    
    static showStatus() {
        Logger.log(`Active streams: ${activeStreams.size}`);
        
        if (activeStreams.size > 0) {
            console.log('\n🎥 ACTIVE STREAMS:');
            activeStreams.forEach((stream, id) => {
                console.log(`  ${stream.info.name} [${id}]`);
            });
            console.log('');
        }
        
        // 5-minute status report
        const now = Date.now();
        if (!this.lastReportTime || now - this.lastReportTime > 300000) {
            console.log('\n' + '📊'.repeat(30));
            console.log('5-MINUTE STATUS REPORT');
            console.log(`Active: ${activeStreams.size} streams`);
            console.log('📊'.repeat(30) + '\n');
            this.lastReportTime = now;
        }
    }
}

// ================== MAIN APPLICATION ==================
async function main() {
    console.log('\n' + '='.repeat(60));
    console.log('🚀 SIMPLE STREAM MONITOR');
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
        await Logger.sendTelegram('🚀 <b>Stream Monitor Started</b>\n' +
                                 `Time: ${new Date().toLocaleString()}`);
    }
    
    // Initial API check
    Logger.log('Performing initial API check...');
    await APIMonitor.monitor();
    
    // Start monitoring loop
    const monitorInterval = setInterval(async () => {
        await APIMonitor.monitor();
    }, CONFIG.api.pollInterval);
    
    // Graceful shutdown
    process.on('SIGINT', () => {
        clearInterval(monitorInterval);
        
        console.log('\n' + '🛑'.repeat(30));
        console.log('GRACEFUL SHUTDOWN');
        console.log('🛑'.repeat(30));
        
        Logger.log('Stopping all streams...');
        
        if (CONFIG.telegram.enabled) {
            Logger.sendTelegram('🛑 <b>Monitor Shutting Down</b>\n' +
                               `Active streams: ${activeStreams.size}`);
        }
        
        const stopped = StreamManager.stopAll();
        
        console.log(`\n✅ Stopped ${stopped} streams`);
        console.log('📝 Logs saved to: streams.log');
        console.log('\n👋 Goodbye!\n');
        
        // Log shutdown
        appendFileSync('streams.log', `\nShutdown: ${new Date().toLocaleString()}\n`);
        
        process.exit(0);
    });
    
    console.log('\n✅ Monitor is running. Press Ctrl+C to stop.\n');
    
    // Keep application running
    while (true) {
        await new Promise(resolve => setTimeout(resolve, 60000));
    }
}

// ================== DIRECT TEST FUNCTION ==================
// Test streams directly (like your working interactive code)
async function testDirect() {
    console.log('\n' + '🧪'.repeat(30));
    console.log('DIRECT STREAM TEST');
    console.log('Testing 2 streams simultaneously');
    console.log('🧪'.repeat(30) + '\n');
    
    const testStreams = [
        {
            id: "100",
            name: "Test Stream 1",
            rtmps_url: "rtmps://live-api-s.facebook.com:443/rtmp/FB-122190346070336092-0-AbwRd0Qw9UCIUyvwG802bBdG",
            rtmp_source: "http://dhoomtv.xyz/8zpo3GsVY7/beneficial2concern/274162",
            status: "active"
        },
        {
            id: "101", 
            name: "Test Stream 2",
            rtmps_url: "rtmps://live-api-s.facebook.com:443/rtmp/FB-122190346070336093-0-AbwRd0Qw9UCIUyvwG802bBdG",
            rtmp_source: "http://dhoomtv.xyz/8zpo3GsVY7/beneficial2concern/274162",
            status: "active"
        }
    ];
    
    // Start both streams with delay (like your working code)
    console.log('🎬 Launching Stream 1...');
    StreamManager.startStream(testStreams[0]);
    
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    console.log('\n🎬 Launching Stream 2...');
    StreamManager.startStream(testStreams[1]);
    
    console.log('\n' + '✅'.repeat(30));
    console.log('BOTH STREAMS LAUNCHED!');
    console.log('Press Ctrl+C to stop both streams');
    console.log('✅'.repeat(30) + '\n');
    
    // Show status every 30 seconds
    const statusInterval = setInterval(() => {
        console.log(`\n🕒 ${new Date().toLocaleTimeString()} - Status:`);
        console.log(`Active streams: ${activeStreams.size}`);
        
        activeStreams.forEach((stream, id) => {
            const isRunning = stream.process.exitCode === null;
            console.log(`  ${stream.info.name}: ${isRunning ? '✅ RUNNING' : '❌ STOPPED'}`);
        });
    }, 30000);
    
    // Handle shutdown
    process.on('SIGINT', () => {
        clearInterval(statusInterval);
        
        console.log('\n🛑 Stopping test streams...');
        const stopped = StreamManager.stopAll();
        console.log(`✅ Stopped ${stopped} streams`);
        console.log('\n👋 Test complete!\n');
        process.exit(0);
    });
    
    // Keep running
    await new Promise(() => {});
}

// ================== MANUAL INPUT FUNCTION ==================
// Interactive mode like your working code
async function interactiveMode() {
    const readline = await import('readline');
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    
    const askQuestion = (question) => {
        return new Promise((resolve) => {
            rl.question(question, (answer) => {
                resolve(answer.trim());
            });
        });
    };
    
    console.log('\n' + '='.repeat(60));
    console.log('🚀 INTERACTIVE STREAM LAUNCHER');
    console.log('='.repeat(60) + '\n');
    
    const streamCount = parseInt(await askQuestion('📊 How many streams? '));
    
    if (isNaN(streamCount) || streamCount < 1) {
        console.log('❌ Invalid number');
        rl.close();
        return;
    }
    
    const streams = [];
    
    for (let i = 1; i <= streamCount; i++) {
        console.log(`\n📺 STREAM ${i}:`);
        const name = await askQuestion('   Name: ');
        const rtmpsUrl = await askQuestion('   RTMPS URL: ');
        const sourceUrl = await askQuestion('   Source URL: ');
        
        streams.push({
            id: `${i}`,
            name: name || `Stream ${i}`,
            rtmps_url: rtmpsUrl,
            rtmp_source: sourceUrl,
            status: "active"
        });
    }
    
    rl.close();
    
    console.log('\n' + '🚀'.repeat(20));
    console.log('LAUNCHING STREAMS');
    console.log('🚀'.repeat(20) + '\n');
    
    // Launch all streams
    streams.forEach((stream, index) => {
        console.log(`🎬 ${stream.name}...`);
        StreamManager.startStream(stream);
        
        // Delay between launches
        if (index < streams.length - 1) {
            setTimeout(() => {}, 2000);
        }
    });
    
    console.log('\n✅ All streams launched!');
    console.log('Press Ctrl+C to stop\n');
    
    // Keep running
    await new Promise(() => {});
}

// ================== STARTUP CHECK ==================
// Check if fetch is available
if (typeof fetch === 'undefined') {
    console.log('⚠️ Installing node-fetch...');
    console.log('Run: npm install node-fetch@3');
    process.exit(1);
}

// ================== RUN SELECTION ==================
console.log('\n' + '🎯'.repeat(30));
console.log('SELECT MODE:');
console.log('1. API Monitor (monitors API and auto-manages streams)');
console.log('2. Direct Test (test 2 streams directly)');
console.log('3. Interactive (enter streams manually)');
console.log('🎯'.repeat(30));

// Simple mode selection
const mode = process.argv[2] || '1';

switch(mode) {
    case '1':
        console.log('\n📡 Starting API Monitor...\n');
        main().catch(error => {
            console.error('💥 Error:', error);
            process.exit(1);
        });
        break;
        
    case '2':
        console.log('\n🧪 Starting Direct Test...\n');
        testDirect().catch(error => {
            console.error('💥 Error:', error);
            process.exit(1);
        });
        break;
        
    case '3':
        console.log('\n🎮 Starting Interactive Mode...\n');
        interactiveMode().catch(error => {
            console.error('💥 Error:', error);
            process.exit(1);
        });
        break;
        
    default:
        console.log('\n📡 Starting API Monitor (default)...\n');
        main().catch(error => {
            console.error('💥 Error:', error);
            process.exit(1);
        });
}
