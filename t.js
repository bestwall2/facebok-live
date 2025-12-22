// ================== IMPORTS ==================
import { spawn } from 'child_process';
import { writeFileSync, appendFileSync } from 'fs';

// ================== CONFIGURATION ==================
const CONFIG = {
    // API endpoint that returns your JSON list
    apiUrl: "https://ani-box-nine.vercel.app/api/grok-chat",
    pollInterval: 60000,  // Check every minute
    restartDelay: 2000,   // Delay before restarting after exception
    maxRetries: 3         // Max retries for API calls
};

// ================== GLOBAL STATE ==================
let activeStreams = new Map();      // streamId -> {process, info, dashUrl}
let allItems = new Map();           // itemId -> {token, name, source, img, pageId, rtmpsUrl, dashUrl}
let isRestarting = false;           // Prevent multiple simultaneous restarts
let lastRestartTime = 0;
let monitoringInterval = null;

// ================== LOGGER ==================
class Logger {
    static log(level, message, itemId = null) {
        const timestamp = new Date().toISOString();
        const logEntry = `[${timestamp}] [${level}] ${itemId ? `[${itemId}] ` : ''}${message}`;
        
        console.log(logEntry);
        appendFileSync('facebook-streams.log', logEntry + '\n');
    }
    
    static error(message, itemId = null) {
        this.log('ERROR', message, itemId);
    }
    
    static info(message, itemId = null) {
        this.log('INFO', message, itemId);
    }
    
    static warn(message, itemId = null) {
        this.log('WARN', message, itemId);
    }
    
    static success(message, itemId = null) {
        this.log('SUCCESS', message, itemId);
    }
}

// ================== FACEBOOK API MANAGER ==================
class FacebookAPI {
    static async getPageId(accessToken) {
        try {
            const response = await fetch('https://graph.facebook.com/v24.0/me/accounts', {
                headers: { 'Authorization': `Bearer ${accessToken}` }
            });
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            const data = await response.json();
            
            if (!data.data || data.data.length === 0) {
                throw new Error('No Facebook pages found for this token');
            }
            
            // Return the first page ID (you might want to handle multiple pages)
            return data.data[0].id;
            
        } catch (error) {
            Logger.error(`Failed to get page ID: ${error.message}`);
            return null;
        }
    }
    
    static async createLiveStream(accessToken, pageId, streamName) {
        for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
            try {
                const response = await fetch(
                    `https://graph.facebook.com/v24.0/${pageId}/live_videos`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            title: streamName,
                            status: 'UNPUBLISHED',
                            access_token: accessToken
                        })
                    }
                );
                
                const data = await response.json();
                
                if (data.error) {
                    if (attempt < CONFIG.maxRetries) {
                        Logger.warn(`Retry ${attempt}/${CONFIG.maxRetries} for ${streamName}`);
                        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
                        continue;
                    }
                    throw new Error(`Facebook API: ${data.error.message}`);
                }
                
                return {
                    streamId: data.id,
                    rtmpsUrl: data.secure_stream_url || data.stream_url
                };
                
            } catch (error) {
                if (attempt === CONFIG.maxRetries) {
                    throw error;
                }
            }
        }
    }
    
    static async getDashUrl(streamId, accessToken) {
        try {
            const response = await fetch(
                `https://graph.facebook.com/v24.0/${streamId}?fields=dash_preview_url&access_token=${accessToken}`
            );
            
            const data = await response.json();
            return data.dash_preview_url;
            
        } catch (error) {
            Logger.error(`Failed to get DASH URL for ${streamId}: ${error.message}`);
            return null;
        }
    }
}

// ================== STREAM PROCESS MANAGER ==================
class StreamManager {
    static startStream(itemInfo, rtmpsUrl) {
        const { id, name, source } = itemInfo;
        
        Logger.info(`Starting FFmpeg for: ${name}`, id);
        
        // SIMPLE FFMPEG COMMAND - Works reliably
        const ffmpeg = spawn("ffmpeg", [
            "-re",
            "-i", source,
            "-c", "copy",
            "-f", "flv",
            rtmpsUrl
        ]);
        
        const streamData = {
            process: ffmpeg,
            info: itemInfo,
            startTime: Date.now(),
            isRunning: true,
            restartCount: 0
        };
        
        // Store in active streams
        activeStreams.set(id, streamData);
        
        // FFmpeg output handling
        ffmpeg.stderr.on('data', (data) => {
            const msg = data.toString();
            
            if (msg.includes('Opening') && msg.includes('output')) {
                Logger.success(`Connected to Facebook`, id);
            }
            
            if (msg.includes('error') || msg.includes('fail') || msg.includes('Invalid')) {
                const errorMsg = msg.substring(0, 100);
                Logger.error(`FFmpeg: ${errorMsg}`, id);
                
                // Trigger restart on error (Exception 2)
                if (!isRestarting) {
                    setTimeout(() => {
                        Logger.warn(`FFmpeg error detected, triggering restart...`, id);
                        ExceptionHandler.handleException('ffmpeg_error');
                    }, 5000);
                }
            }
        });
        
        ffmpeg.on('close', (code) => {
            streamData.isRunning = false;
            Logger.warn(`FFmpeg exited with code ${code}`, id);
            
            // If not during restart and not a clean exit, trigger restart
            if (!isRestarting && code !== 0) {
                setTimeout(() => {
                    Logger.warn(`FFmpeg crash detected, triggering restart...`, id);
                    ExceptionHandler.handleException('ffmpeg_crash');
                }, 5000);
            }
        });
        
        ffmpeg.on('error', (error) => {
            Logger.error(`Process error: ${error.message}`, id);
            activeStreams.delete(id);
        });
        
        return ffmpeg;
    }
    
    static stopAllStreams() {
        Logger.info(`Stopping ${activeStreams.size} active streams...`);
        
        let stoppedCount = 0;
        activeStreams.forEach((stream, id) => {
            try {
                if (stream.process && stream.process.exitCode === null) {
                    stream.process.kill('SIGTERM');
                    stoppedCount++;
                }
            } catch (error) {
                Logger.error(`Error stopping stream ${id}: ${error.message}`);
            }
        });
        
        activeStreams.clear();
        Logger.info(`Stopped ${stoppedCount} streams`);
        return stoppedCount;
    }
    
    static getActiveStreams() {
        const active = [];
        activeStreams.forEach((stream, id) => {
            if (stream.isRunning) {
                active.push({
                    id,
                    name: stream.info.name,
                    running: true
                });
            }
        });
        return active;
    }
}

// ================== EXCEPTION HANDLER ==================
class ExceptionHandler {
    static async handleException(type) {
        // Prevent multiple simultaneous restarts
        if (isRestarting) {
            Logger.warn(`Already restarting, skipping ${type} exception`);
            return;
        }
        
        const now = Date.now();
        if (now - lastRestartTime < 30000) { // 30 second cooldown
            Logger.warn(`Restart cooldown active, skipping ${type} exception`);
            return;
        }
        
        isRestarting = true;
        lastRestartTime = now;
        
        Logger.warn(`=== HANDLING EXCEPTION: ${type.toUpperCase()} ===`);
        
        try {
            // Stop all current streams
            StreamManager.stopAllStreams();
            
            // Wait a bit
            await new Promise(resolve => setTimeout(resolve, CONFIG.restartDelay));
            
            // Restart everything
            await MainManager.restartAllStreams();
            
            Logger.success(`Exception ${type} handled successfully`);
            
        } catch (error) {
            Logger.error(`Failed to handle exception ${type}: ${error.message}`);
        } finally {
            isRestarting = false;
        }
    }
}

// ================== MAIN STREAM MANAGER ==================
class MainManager {
    static async fetchItemsList() {
        try {
            const response = await fetch(CONFIG.apiUrl);
            const data = await response.json();
            
            // Handle nested data structure
            const apiData = data.data || data;
            
            if (!apiData.success || !apiData.data) {
                throw new Error('Invalid API response format');
            }
            
            // Transform to our format
            const items = new Map();
            apiData.data.forEach((item, index) => {
                const itemId = item.id || `item_${index}_${Date.now()}`;
                items.set(itemId, {
                    id: itemId,
                    token: item.access_token || item.token,
                    name: item.name,
                    source: item.rtmp_source || item.source,
                    img: item.img || item.image || 'default.jpg',
                    pageId: null,
                    rtmpsUrl: null,
                    dashUrl: null
                });
            });
            
            return items;
            
        } catch (error) {
            Logger.error(`Failed to fetch items list: ${error.message}`);
            return new Map();
        }
    }
    
    static async processAllItems() {
        Logger.info(`Processing ${allItems.size} items...`);
        
        const processedItems = new Map();
        
        // Process each item sequentially
        for (const [itemId, item] of allItems) {
            try {
                Logger.info(`Processing: ${item.name}`, itemId);
                
                // 1. Get Page ID using token
                if (!item.pageId) {
                    item.pageId = await FacebookAPI.getPageId(item.token);
                    if (!item.pageId) {
                        Logger.error(`Skipping ${item.name} - No page ID`, itemId);
                        continue;
                    }
                    Logger.success(`Got page ID: ${item.pageId}`, itemId);
                }
                
                // 2. Create Facebook Live stream
                if (!item.rtmpsUrl) {
                    const liveStream = await FacebookAPI.createLiveStream(
                        item.token,
                        item.pageId,
                        item.name
                    );
                    
                    item.rtmpsUrl = liveStream.rtmpsUrl;
                    item.streamId = liveStream.streamId;
                    Logger.success(`Created live stream: ${item.streamId}`, itemId);
                    
                    // 3. Get DASH URL
                    await new Promise(resolve => setTimeout(resolve, 3000)); // Wait for stream to initialize
                    item.dashUrl = await FacebookAPI.getDashUrl(item.streamId, item.token);
                    
                    if (item.dashUrl) {
                        Logger.success(`Got DASH URL`, itemId);
                    }
                }
                
                // Store processed item
                processedItems.set(itemId, item);
                
            } catch (error) {
                Logger.error(`Failed to process ${item.name}: ${error.message}`, itemId);
            }
        }
        
        return processedItems;
    }
    
    static async startAllStreams(processedItems) {
        Logger.info(`Starting ${processedItems.size} streams...`);
        
        // Start all streams at once
        processedItems.forEach((item, itemId) => {
            if (item.rtmpsUrl && item.source) {
                StreamManager.startStream(item, item.rtmpsUrl);
            }
        });
        
        // Wait a moment for streams to initialize
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        // Check which streams are actually running
        const runningStreams = StreamManager.getActiveStreams();
        Logger.success(`${runningStreams.length}/${processedItems.size} streams started successfully`);
        
        return runningStreams.length === processedItems.size;
    }
    
    static async restartAllStreams() {
        Logger.info('=== RESTARTING ALL STREAMS ===');
        
        // Stop everything first
        StreamManager.stopAllStreams();
        
        // Fetch fresh items list
        const newItems = await this.fetchItemsList();
        
        // Check for changes (Exception 1 & 3)
        const changes = this.detectChanges(allItems, newItems);
        
        if (changes.added > 0 || changes.removed > 0 || changes.changed > 0) {
            Logger.warn(`Changes detected: +${changes.added} -${changes.removed} ~${changes.changed}`);
            allItems = newItems;
        }
        
        // Process all items
        const processedItems = await this.processAllItems();
        
        // Start all streams
        const success = await this.startAllStreams(processedItems);
        
        if (success) {
            // Generate and output JSON
            this.outputStreamJson(processedItems);
        }
        
        return success;
    }
    
    static detectChanges(oldItems, newItems) {
        const changes = { added: 0, removed: 0, changed: 0 };
        
        // Check removed items
        oldItems.forEach((item, id) => {
            if (!newItems.has(id)) {
                changes.removed++;
            }
        });
        
        // Check added/changed items
        newItems.forEach((newItem, id) => {
            const oldItem = oldItems.get(id);
            if (!oldItem) {
                changes.added++;
            } else if (
                oldItem.token !== newItem.token ||
                oldItem.name !== newItem.name ||
                oldItem.source !== newItem.source ||
                oldItem.img !== newItem.img
            ) {
                changes.changed++;
            }
        });
        
        return changes;
    }
    
    static outputStreamJson(processedItems) {
        const output = [];
        
        processedItems.forEach((item, itemId) => {
            if (item.dashUrl && activeStreams.get(itemId)?.isRunning) {
                output.push({
                    name: item.name,
                    img: item.img,
                    mpd: item.dashUrl,
                    accesstoken: item.token,
                    status: 'live',
                    timestamp: new Date().toISOString()
                });
            }
        });
        
        if (output.length > 0) {
            console.log('\n' + '='.repeat(80));
            console.log('STREAM JSON OUTPUT (Ready for Facebook Post):');
            console.log('='.repeat(80));
            console.log(JSON.stringify(output, null, 2));
            console.log('='.repeat(80) + '\n');
            
            // Also save to file
            writeFileSync(CONFIG.logging?.statusFile || 'stream-status.json', 
                         JSON.stringify(output, null, 2));
            
            Logger.success(`Generated JSON for ${output.length} live streams`);
        } else {
            Logger.warn('No live streams to output in JSON');
        }
    }
}

// ================== MONITORING SYSTEM ==================
class Monitor {
    static start() {
        Logger.info('Starting monitoring system...');
        
        // Initial restart
        MainManager.restartAllStreams().catch(console.error);
        
        // Start periodic monitoring
        monitoringInterval = setInterval(async () => {
            try {
                await this.checkAndUpdate();
            } catch (error) {
                Logger.error(`Monitor error: ${error.message}`);
            }
        }, CONFIG.pollInterval);
        
        Logger.success('Monitoring system started');
    }
    
    static async checkAndUpdate() {
        if (isRestarting) {
            return; // Skip if already restarting
        }
        
        Logger.info('Performing periodic check...');
        
        try {
            // Fetch fresh items list
            const newItems = await MainManager.fetchItemsList();
            
            // Check for changes
            const changes = MainManager.detectChanges(allItems, newItems);
            
            if (changes.added > 0 || changes.removed > 0) {
                Logger.warn(`API changes detected, triggering restart...`);
                ExceptionHandler.handleException('api_change');
            } else {
                // Check stream health
                const activeCount = StreamManager.getActiveStreams().length;
                const expectedCount = allItems.size;
                
                if (activeCount < expectedCount) {
                    Logger.warn(`Stream count mismatch: ${activeCount}/${expectedCount}, triggering restart...`);
                    ExceptionHandler.handleException('stream_mismatch');
                } else if (activeCount === expectedCount && activeCount > 0) {
                    // All streams healthy, output JSON
                    MainManager.outputStreamJson(allItems);
                }
            }
            
        } catch (error) {
            Logger.error(`Check error: ${error.message}`);
        }
    }
    
    static stop() {
        if (monitoringInterval) {
            clearInterval(monitoringInterval);
            monitoringInterval = null;
        }
        StreamManager.stopAllStreams();
        Logger.info('Monitoring system stopped');
    }
}

// ================== MAIN APPLICATION ==================
class Application {
    static async start() {
        console.log('\n' + '='.repeat(80));
        console.log('🚀 FACEBOOK MULTI-STREAM MANAGER');
        console.log('Automatic error recovery & JSON output');
        console.log('='.repeat(80) + '\n');
        
        // Create log file
        try {
            writeFileSync('facebook-streams.log', 
                         `=== Facebook Stream Manager Started ===\n` +
                         `Time: ${new Date().toISOString()}\n` +
                         `API: ${CONFIG.apiUrl}\n` +
                         '='.repeat(50) + '\n');
        } catch (e) {
            console.error('Log init failed:', e.message);
        }
        
        // Handle uncaught errors
        process.on('uncaughtException', (error) => {
            Logger.error(`Uncaught exception: ${error.message}`);
            Logger.error(`Stack: ${error.stack}`);
            
            // Try to restart
            setTimeout(() => {
                ExceptionHandler.handleException('uncaught_exception');
            }, 5000);
        });
        
        process.on('unhandledRejection', (reason, promise) => {
            Logger.error(`Unhandled rejection at: ${promise}, reason: ${reason}`);
        });
        
        // Graceful shutdown
        process.on('SIGINT', () => {
            console.log('\n' + '🛑'.repeat(30));
            console.log('GRACEFUL SHUTDOWN');
            console.log('🛑'.repeat(30));
            
            Monitor.stop();
            
            console.log(`\n✅ Stopped all streams`);
            console.log('📝 Logs: facebook-streams.log');
            console.log('📊 Status: stream-status.json');
            console.log('\n👋 Goodbye!\n');
            
            process.exit(0);
        });
        
        // Start the system
        Monitor.start();
        
        // Keep alive
        while (true) {
            await new Promise(resolve => setTimeout(resolve, 60000));
        }
    }
}

// ================== START APPLICATION ==================
// Create package.json if needed
try {
    const fs = await import('fs');
    if (!fs.existsSync('package.json')) {
        fs.writeFileSync('package.json', JSON.stringify({
            "type": "module",
            "name": "facebook-stream-manager",
            "version": "1.0.0"
        }, null, 2));
        console.log('✅ Created package.json');
    }
} catch (e) {
    // Continue anyway
}

// Check for fetch
if (typeof fetch === 'undefined') {
    console.log('⚠️ Installing node-fetch...');
    console.log('Run: npm install node-fetch@3');
    process.exit(1);
}

// Start
Application.start().catch(error => {
    console.error('\n💥 FATAL ERROR:', error);
    console.error('Stack:', error.stack);
    process.exit(1);
});
