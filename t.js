import { spawn } from 'child_process';
import fetch from 'node-fetch';

/**
 * SIMPLE MULTI-STREAM FACEBOOK LIVE MANAGER
 * Creates multiple unpublished Facebook Live streams
 * Each with its own DASH preview URL
 */

// ================== CONFIGURATION ==================
const CONFIG = {
    // Your Facebook credentials
    facebook: {
        pageId: "285026604702057",           // Replace with your Facebook Page ID
        accessToken: "EAATr298atI4BQfoFhBrpyYS62wZBh4H31p7PWJgn6CHcaP8JfsdfD5dcUmlYX1JbjwVdfDSWN4KjoVT2uulhEZAStwQdbfylZB1Pr7asqMg7FCAVa6lFrAPZCOyGLvrsAxahV8uo4B1LvyBIGAQ6FZAy5ERZAIM38L4QlML9oJbaVolC6voc2TmAhtLxgZCILPo70tDtRqi", // Replace with your Page Access Token
        apiVersion: "v24.0"
    },
    
    // Stream configurations - ADD YOUR STREAMS HERE
    streams: [
        {
            name: "Sports Channel 1",
            inputUrl: "https://live-hls-web-aja.getaj.net/AJA/index.m3u8",
            key: "sports1"
        },
        {
            name: "Sports Channel 2", 
            inputUrl: "http://dhoomtv.xyz/8zpo3GsVY7/beneficial2concern/274160", // Your second stream
            key: "sports2"
        }
        // Add more streams as needed...
    ]
};

// ================== HELPER FUNCTIONS ==================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function generateStreamId() {
    return `stream_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
}

// ================== FACEBOOK API FUNCTIONS ==================
async function createFacebookStream(title) {
    try {
        const response = await fetch(
            `https://graph.facebook.com/${CONFIG.facebook.apiVersion}/${CONFIG.facebook.pageId}/live_videos`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: title,
                    status: "UNPUBLISHED",  // Important: Keeps stream private
                    access_token: CONFIG.facebook.accessToken,
                    description: "Live broadcast"
                })
            }
        );

        const data = await response.json();
        
        if (data.error) {
            throw new Error(`Facebook API Error: ${data.error.message}`);
        }

        return {
            streamId: data.id,
            rtmpsUrl: data.secure_stream_url,
            status: "UNPUBLISHED"
        };
    } catch (error) {
        console.error('❌ Failed to create Facebook stream:', error.message);
        throw error;
    }
}

async function getDashPreviewUrl(streamId) {
    try {
        const response = await fetch(
            `https://graph.facebook.com/${CONFIG.facebook.apiVersion}/${streamId}?fields=dash_preview_url,status&access_token=${CONFIG.facebook.accessToken}`
        );

        const data = await response.json();
        
        if (data.error) {
            console.warn(`⚠️ Could not get DASH URL for ${streamId}: ${data.error.message}`);
            return null;
        }

        return data.dash_preview_url;
    } catch (error) {
        console.error(`❌ Error fetching DASH URL:`, error.message);
        return null;
    }
}

// ================== FFMPEG STREAMER ==================
function startFFmpegStream(inputUrl, rtmpsUrl, streamKey, title) {
    console.log(`🚀 Starting FFmpeg for: ${title}`);
    
    const args = [
        "-re",
        "-i", inputUrl,
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
        rtmpsUrl
    ];

    const ffmpeg = spawn("ffmpeg", args);

    // Log FFmpeg status
    ffmpeg.stderr.on('data', (data) => {
        const message = data.toString();
        if (message.includes('frame=') && Math.random() < 0.1) {
            console.log(`📊 [${streamKey}] ${message.substring(0, 60)}...`);
        }
    });

    ffmpeg.on('close', (code) => {
        console.log(`🔴 FFmpeg for ${streamKey} exited with code ${code}`);
    });

    ffmpeg.on('error', (err) => {
        console.error(`🔥 FFmpeg error for ${streamKey}:`, err.message);
    });

    return ffmpeg;
}

// ================== STREAM MANAGER ==================
class MultiStreamManager {
    constructor() {
        this.activeStreams = new Map(); // key -> {streamInfo, ffmpegProcess, dashUrl}
    }

    async startStream(streamConfig) {
        const streamKey = streamConfig.key || generateStreamId();
        
        console.log(`\n${'='.repeat(50)}`);
        console.log(`🎬 STARTING STREAM: ${streamConfig.name}`);
        console.log(`${'='.repeat(50)}`);

        try {
            // 1. Create Facebook Live stream
            const facebookStream = await createFacebookStream(streamConfig.name);
            
            if (!facebookStream.rtmpsUrl) {
                throw new Error('No RTMPS URL received from Facebook');
            }

            // 2. Start FFmpeg
            const ffmpegProcess = startFFmpegStream(
                streamConfig.inputUrl,
                facebookStream.rtmpsUrl,
                streamKey,
                streamConfig.name
            );

            // 3. Store stream info
            const streamInfo = {
                key: streamKey,
                name: streamConfig.name,
                facebookId: facebookStream.streamId,
                rtmpsUrl: facebookStream.rtmpsUrl,
                inputUrl: streamConfig.inputUrl,
                ffmpegProcess: ffmpegProcess,
                dashUrl: null,
                startTime: new Date()
            };

            this.activeStreams.set(streamKey, streamInfo);
            
            console.log(`✅ Facebook Live created: ${facebookStream.streamId}`);
            console.log(`📺 Streaming from: ${streamConfig.inputUrl}`);

            // 4. Wait and get DASH URL
            console.log(`⏳ Waiting for DASH preview URL...`);
            await sleep(10000); // Wait 10 seconds for stream to initialize
            
            const dashUrl = await getDashPreviewUrl(facebookStream.streamId);
            
            if (dashUrl) {
                streamInfo.dashUrl = dashUrl;
                console.log(`\n🎉 DASH PREVIEW URL FOR "${streamConfig.name}":`);
                console.log(`🔗 ${dashUrl}`);
                console.log(`📋 Copy this URL into a DASH player (like dash.js) to preview`);
            } else {
                console.warn(`⚠️ DASH URL not available yet for ${streamConfig.name}`);
            }

            return streamInfo;

        } catch (error) {
            console.error(`❌ Failed to start stream ${streamConfig.name}:`, error.message);
            throw error;
        }
    }

    async startAllStreams() {
        console.log(`\n${'🚀'.repeat(20)}`);
        console.log(`STARTING ${CONFIG.streams.length} STREAMS`);
        console.log(`${'🚀'.repeat(20)}\n`);

        const results = [];
        
        for (const streamConfig of CONFIG.streams) {
            try {
                const streamInfo = await this.startStream(streamConfig);
                results.push(streamInfo);
                
                // Delay between starting streams
                if (streamConfig !== CONFIG.streams[CONFIG.streams.length - 1]) {
                    await sleep(3000);
                }
                
            } catch (error) {
                console.error(`Failed to start ${streamConfig.name}:`, error.message);
                results.push({ error: error.message, config: streamConfig });
            }
        }

        return results;
    }

    getDashboard() {
        console.log(`\n${'📊'.repeat(20)}`);
        console.log(`ACTIVE STREAMS DASHBOARD`);
        console.log(`${'📊'.repeat(20)}`);

        if (this.activeStreams.size === 0) {
            console.log('No active streams.');
            return;
        }

        this.activeStreams.forEach((info, key) => {
            console.log(`\n📺 ${info.name} [${key}]`);
            console.log(`   🆔 Facebook ID: ${info.facebookId}`);
            console.log(`   🕐 Started: ${info.startTime.toLocaleTimeString()}`);
            console.log(`   🔗 DASH URL: ${info.dashUrl ? '✅ Available' : '⏳ Pending'}`);
            
            if (info.dashUrl) {
                console.log(`   📋 Preview: ${info.dashUrl.substring(0, 80)}...`);
            }
            
            const isRunning = info.ffmpegProcess?.exitCode === null;
            console.log(`   🎥 FFmpeg: ${isRunning ? '✅ Running' : '❌ Stopped'}`);
        });
    }

    async shutdown() {
        console.log(`\n${'🔴'.repeat(20)}`);
        console.log(`SHUTTING DOWN ALL STREAMS`);
        
        this.activeStreams.forEach((info, key) => {
            if (info.ffmpegProcess) {
                info.ffmpegProcess.kill('SIGTERM');
                console.log(`🛑 Stopped ${info.name}`);
            }
        });
        
        this.activeStreams.clear();
        console.log(`✅ All streams stopped.`);
    }
}

// ================== MAIN APPLICATION ==================
async function main() {
    console.log(`
    ╔═══════════════════════════════════════════════╗
    ║    MULTI-STREAM FACEBOOK LIVE MANAGER         ║
    ║    Simple Single-File Solution                ║
    ╚═══════════════════════════════════════════════╝
    `);

    const manager = new MultiStreamManager();

    try {
        // Start all streams
        await manager.startAllStreams();
        
        // Show dashboard
        console.log(`\n${'✅'.repeat(20)}`);
        console.log(`ALL STREAMS INITIALIZED`);
        console.log(`Waiting for DASH URLs...\n`);
        
        // Initial dashboard
        manager.getDashboard();
        
        // Poll for DASH URLs every 30 seconds
        const pollInterval = setInterval(async () => {
            console.log(`\n🔄 Polling for DASH URLs...`);
            
            for (const [key, info] of manager.activeStreams) {
                if (!info.dashUrl) {
                    const dashUrl = await getDashPreviewUrl(info.facebookId);
                    if (dashUrl) {
                        info.dashUrl = dashUrl;
                        console.log(`\n🎉 NEW DASH URL FOR "${info.name}":`);
                        console.log(`🔗 ${dashUrl}`);
                    }
                }
            }
            
            manager.getDashboard();
        }, 30000);

        // Keep application running
        console.log(`\n📱 Application running. Press Ctrl+C to exit.\n`);
        
        process.on('SIGINT', async () => {
            clearInterval(pollInterval);
            console.log(`\n📴 Received shutdown signal...`);
            await manager.shutdown();
            process.exit(0);
        });

        // Keep process alive
        await new Promise(() => {});

    } catch (error) {
        console.error(`❌ Application error:`, error);
        await manager.shutdown();
        process.exit(1);
    }
}

// ================== RUN APPLICATION ==================
if (import.meta.url === `file://${process.argv[1]}`) {
    // Install dependencies first: npm install node-fetch
    main().catch(console.error);
}
