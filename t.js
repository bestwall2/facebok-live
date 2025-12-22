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

// ================== SIMPLE HELPER ==================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ================== CORE FUNCTIONS ==================
async function createFacebookStream(name) {
    const response = await fetch(
        `https://graph.facebook.com/${CONFIG.facebook.apiVersion}/${CONFIG.facebook.pageId}/live_videos`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: name,
                status: "UNPUBLISHED",
                access_token: CONFIG.facebook.accessToken
            })
        }
    );
    return await response.json();
}

async function getDashUrl(streamId) {
    const response = await fetch(
        `https://graph.facebook.com/v24.0/${streamId}?fields=dash_preview_url&access_token=${CONFIG.facebook.accessToken}`
    );
    const data = await response.json();
    return data.dash_preview_url;
}

function startFFmpeg(inputUrl, rtmpsUrl, streamKey, name) {
    console.log(`🚀 [${streamKey}] Starting FFmpeg for "${name}"`);
    console.log(`   📥 Input: ${inputUrl}`);
    console.log(`   📤 Output: ${rtmpsUrl.substring(0, 50)}...`);
    
    const ffmpeg = spawn("ffmpeg", [
        "-re", "-i", inputUrl,
        "-map", "0:v:0", "-map", "0:a:0",
        "-c:v", "libx264", "-preset", "ultrafast", // Using ultrafast for lower CPU
        "-pix_fmt", "yuv420p", "-r", "25", "-g", "50",
        "-b:v", "2000k", "-maxrate", "2000k", "-bufsize", "4000k", // Lower bitrate
        "-c:a", "aac", "-ar", "44100", "-b:a", "96k", "-ac", "2",
        "-f", "flv",
        rtmpsUrl
    ]);

    // CRITICAL: Log ALL FFmpeg output to debug issues
    ffmpeg.stderr.on('data', (data) => {
        const msg = data.toString();
        if (msg.includes('error') || msg.includes('fail') || msg.includes('Invalid')) {
            console.error(`🔥 [${streamKey}] FFmpeg ERROR: ${msg.trim()}`);
        } else if (msg.includes('frame=')) {
            // Log progress every 100 frames
            if (Math.random() < 0.3) {
                const match = msg.match(/frame=\s*(\d+).*time=([\d:.]+)/);
                if (match) console.log(`📊 [${streamKey}] Frame: ${match[1]}, Time: ${match[2]}`);
            }
        }
    });

    ffmpeg.on('close', (code) => {
        console.log(`🔴 [${streamKey}] FFmpeg exited with code ${code}`);
    });

    ffmpeg.on('error', (err) => {
        console.error(`💥 [${streamKey}] FFmpeg process error: ${err.message}`);
    });

    return ffmpeg;
}

// ================== MAIN STREAM MANAGER ==================
async function startAllStreams() {
    console.log('\n' + '='.repeat(60));
    console.log('STARTING MULTIPLE FACEBOOK LIVE STREAMS');
    console.log('='.repeat(60) + '\n');

    const streams = [];
    
    for (const config of CONFIG.streams) {
        console.log(`\n▶️  Setting up: ${config.name} (${config.key})`);
        
        try {
            // Step 1: Create Facebook stream
            console.log(`   📡 Creating Facebook Live...`);
            const fbStream = await createFacebookStream(config.name);
            
            if (fbStream.error) {
                console.error(`   ❌ Facebook error: ${fbStream.error.message}`);
                continue; // Skip to next stream
            }
            
            console.log(`   ✅ Created stream ID: ${fbStream.id}`);
            console.log(`   🔗 RTMPS URL: ${fbStream.secure_stream_url.substring(0, 60)}...`);
            
            // Step 2: Start FFmpeg
            const ffmpegProcess = startFFmpeg(
                config.inputUrl,
                fbStream.secure_stream_url,
                config.key,
                config.name
            );
            
            // Step 3: Wait for stream to initialize
            console.log(`   ⏳ Waiting 15 seconds for stream to start...`);
            await sleep(15000);
            
            // Step 4: Get DASH URL
            console.log(`   📥 Fetching DASH preview URL...`);
            const dashUrl = await getDashUrl(fbStream.id);
            
            const streamInfo = {
                key: config.key,
                name: config.name,
                facebookId: fbStream.id,
                dashUrl: dashUrl || 'Not available yet',
                ffmpegProcess: ffmpegProcess,
                running: true
            };
            
            streams.push(streamInfo);
            
            // Step 5: Display DASH URL
            console.log(`\n   🎉 DASH PREVIEW URL FOR "${config.name}":`);
            console.log(`   🔗 ${dashUrl || 'Will retry in next poll...'}`);
            console.log('   '.padEnd(60, '-'));
            
            // Delay between starting streams
            if (config !== CONFIG.streams[CONFIG.streams.length - 1]) {
                console.log(`\n⏸️  Waiting 5 seconds before next stream...\n`);
                await sleep(5000);
            }
            
        } catch (error) {
            console.error(`   ❌ Failed to setup ${config.name}: ${error.message}`);
        }
    }
    
    return streams;
}

// ================== MONITORING & DISPLAY ==================
function showDashboard(streams) {
    console.log('\n' + '📊'.repeat(25));
    console.log('STREAM DASHBOARD');
    console.log('📊'.repeat(25));
    
    if (streams.length === 0) {
        console.log('No active streams');
        return;
    }
    
    streams.forEach((stream, index) => {
        console.log(`\n${index + 1}. 📺 ${stream.name} [${stream.key}]`);
        console.log(`   🆔 Facebook ID: ${stream.facebookId}`);
        console.log(`   🎥 FFmpeg: ${stream.running ? '✅ RUNNING' : '❌ STOPPED'}`);
        console.log(`   🔗 DASH URL: ${stream.dashUrl ? '✅ AVAILABLE' : '⏳ PENDING'}`);
        
        if (stream.dashUrl && stream.dashUrl !== 'Not available yet') {
            console.log(`   📋 ${stream.dashUrl.substring(0, 70)}...`);
        }
    });
}

async function monitorStreams(streams) {
    console.log('\n' + '🔄'.repeat(25));
    console.log('STARTING MONITORING (updates every 30 seconds)');
    console.log('🔄'.repeat(25));
    
    // Monitor loop
    const interval = setInterval(async () => {
        console.log(`\n🕒 ${new Date().toLocaleTimeString()} - Checking streams...`);
        
        for (const stream of streams) {
            // Check if FFmpeg is still running
            stream.running = stream.ffmpegProcess.exitCode === null;
            
            // Try to get DASH URL if we don't have it yet
            if (!stream.dashUrl || stream.dashUrl === 'Not available yet') {
                const dashUrl = await getDashUrl(stream.facebookId);
                if (dashUrl) {
                    stream.dashUrl = dashUrl;
                    console.log(`\n🎉 NEW DASH URL FOR "${stream.name}":`);
                    console.log(`🔗 ${dashUrl}`);
                }
            }
        }
        
        showDashboard(streams);
        console.log('\nPress Ctrl+C to stop all streams and exit');
        
    }, 30000); // Check every 30 seconds
    
    return interval;
}

// ================== MAIN APPLICATION ==================
async function main() {
    console.log('🚀 Multi-Stream Facebook Live Manager\n');
    
    // Step 1: Start all streams
    const streams = await startAllStreams();
    
    // Step 2: Initial dashboard
    showDashboard(streams);
    
    // Step 3: Start monitoring
    const monitorInterval = await monitorStreams(streams);
    
    // Step 4: Graceful shutdown
    process.on('SIGINT', () => {
        console.log('\n\n' + '🛑'.repeat(25));
        console.log('SHUTTING DOWN ALL STREAMS');
        console.log('🛑'.repeat(25));
        
        clearInterval(monitorInterval);
        
        streams.forEach(stream => {
            if (stream.ffmpegProcess && stream.running) {
                console.log(`🛑 Stopping ${stream.name}...`);
                stream.ffmpegProcess.kill('SIGTERM');
            }
        });
        
        console.log('✅ All streams stopped. Goodbye!\n');
        process.exit(0);
    });
    
    // Keep the application running
    await new Promise(() => {});
}

// ================== RUN THE APPLICATION ==================
main().catch(error => {
    console.error('💥 FATAL ERROR:', error);
    process.exit(1);
});
