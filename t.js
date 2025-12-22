import { spawn } from 'child_process';
import fetch from 'node-fetch';
import readline from 'readline';

// ================== CONFIGURATION ==================
const CONFIG = {
    facebook: {
        pageId: "",           // Will ask user
        accessToken: "",      // Will ask user
        apiVersion: "v24.0"
    },
    streams: {
        count: 3,             // Number of streams to create
        delayBeforeStart: 100 // ms to wait before starting all
    }
};

// ================== SETUP USER INPUT ==================
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

// ================== FACEBOOK API FUNCTIONS ==================
async function createFacebookLiveStream(title, accessToken, pageId) {
    try {
        const response = await fetch(
            `https://graph.facebook.com/${CONFIG.facebook.apiVersion}/${pageId}/live_videos`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: title,
                    status: "UNPUBLISHED",
                    access_token: accessToken
                })
            }
        );

        const data = await response.json();
        
        if (data.error) {
            throw new Error(`Facebook API: ${data.error.message}`);
        }

        console.log(`   ✅ Created: ${data.id}`);
        
        return {
            streamId: data.id,
            rtmpsUrl: data.secure_stream_url || data.stream_url,
            title: title
        };
        
    } catch (error) {
        console.error(`   ❌ Failed to create stream: ${error.message}`);
        throw error;
    }
}

async function getDashUrl(streamId, accessToken) {
    try {
        const response = await fetch(
            `https://graph.facebook.com/${CONFIG.facebook.apiVersion}/${streamId}?fields=dash_preview_url&access_token=${accessToken}`
        );
        const data = await response.json();
        return data.dash_preview_url;
    } catch (error) {
        console.error(`   ❌ Failed to get DASH URL: ${error.message}`);
        return null;
    }
}

// ================== FFMPEG STREAM FUNCTION ==================
function startFFmpegStream(streamInfo, inputUrl) {
    const { title, rtmpsUrl, streamId } = streamInfo;
    
    console.log(`   🚀 Starting: ${title} (${streamId})`);
    
    const args = [
        "-re",                    // Read at native frame rate
        "-i", inputUrl,           // Input source URL
        "-c", "copy",             // Copy codec (no re-encoding)
        "-f", "flv",              // Output format
        rtmpsUrl                  // RTMPS destination
    ];
    
    const ffmpeg = spawn("ffmpeg", args);
    
    // Store stream info with process
    const streamData = {
        process: ffmpeg,
        info: streamInfo,
        inputUrl: inputUrl,
        startTime: Date.now(),
        isRunning: true
    };
    
    // FFmpeg output handling
    ffmpeg.stderr.on('data', (data) => {
        const msg = data.toString();
        
        if (msg.includes('Opening') && msg.includes('output')) {
            console.log(`   🔓 ${title}: Connected to Facebook`);
        }
        
        if (msg.includes('error') || msg.includes('fail')) {
            const errorMsg = msg.substring(0, 100);
            console.error(`   🔥 ${title}: ${errorMsg}`);
        }
        
        if (msg.includes('frame=') && Math.random() < 0.05) {
            const frameMatch = msg.match(/frame=\s*(\d+)/);
            if (frameMatch) {
                console.log(`   📊 ${title}: Frame ${frameMatch[1]}`);
            }
        }
    });
    
    ffmpeg.on('close', (code) => {
        console.log(`   🔴 ${title}: Stopped (code: ${code})`);
        streamData.isRunning = false;
    });
    
    ffmpeg.on('error', (error) => {
        console.error(`   💥 ${title}: Process error: ${error.message}`);
        streamData.isRunning = false;
    });
    
    return streamData;
}

// ================== CREATE & START ALL STREAMS ==================
async function createAndStartAllStreams() {
    console.log('\n' + '📡'.repeat(30));
    console.log('CREATING 3 FACEBOOK LIVE STREAMS');
    console.log('📡'.repeat(30) + '\n');
    
    const streams = [];
    const createdStreams = [];
    
    // Step 1: Get user input for all streams
    for (let i = 1; i <= CONFIG.streams.count; i++) {
        console.log(`📺 STREAM ${i}:`);
        
        const name = await askQuestion(`   Stream title: `);
        const sourceUrl = await askQuestion(`   Source URL (M3U8/MP4): `);
        
        streams.push({
            id: i,
            name: name || `Facebook Live ${i}`,
            sourceUrl: sourceUrl,
            facebookStream: null,
            ffmpegProcess: null
        });
        
        console.log(`   ✅ Stream ${i} configured\n`);
    }
    
    // Step 2: Create all Facebook Live streams
    console.log('\n' + '🔄'.repeat(30));
    console.log('CREATING FACEBOOK LIVE OBJECTS');
    console.log('🔄'.repeat(30) + '\n');
    
    for (const stream of streams) {
        console.log(`📡 Creating: ${stream.name}...`);
        
        try {
            const facebookStream = await createFacebookLiveStream(
                stream.name,
                CONFIG.facebook.accessToken,
                CONFIG.facebook.pageId
            );
            
            stream.facebookStream = facebookStream;
            createdStreams.push(stream);
            
            console.log(`   🔗 RTMPS: ${facebookStream.rtmpsUrl.substring(0, 60)}...\n`);
            
            // Get DASH URL for preview
            const dashUrl = await getDashUrl(facebookStream.streamId, CONFIG.facebook.accessToken);
            if (dashUrl) {
                console.log(`   📺 DASH Preview: ${dashUrl.substring(0, 60)}...\n`);
            }
            
        } catch (error) {
            console.error(`   ❌ Skipping stream ${stream.name}\n`);
        }
    }
    
    if (createdStreams.length === 0) {
        console.log('❌ No streams created successfully');
        rl.close();
        return [];
    }
    
    // Step 3: Wait 100ms before starting all
    console.log(`\n⏳ Waiting ${CONFIG.streams.delayBeforeStart}ms before starting all streams...\n`);
    await new Promise(resolve => setTimeout(resolve, CONFIG.streams.delayBeforeStart));
    
    // Step 4: Start ALL streams at once
    console.log('\n' + '🚀'.repeat(30));
    console.log('STARTING ALL STREAMS SIMULTANEOUSLY');
    console.log('🚀'.repeat(30) + '\n');
    
    const startTime = Date.now();
    const activeStreams = [];
    
    // Start all streams in parallel
    const startPromises = createdStreams.map(stream => {
        return new Promise((resolve) => {
            const streamData = startFFmpegStream(
                {
                    title: stream.name,
                    rtmpsUrl: stream.facebookStream.rtmpsUrl,
                    streamId: stream.facebookStream.streamId
                },
                stream.sourceUrl
            );
            
            stream.ffmpegProcess = streamData;
            activeStreams.push(stream);
            
            console.log(`✅ ${stream.name} launched!`);
            resolve(stream);
        });
    });
    
    // Wait for all to be launched
    await Promise.all(startPromises);
    
    const launchTime = Date.now() - startTime;
    console.log(`\n⚡ Launched ${activeStreams.length} streams in ${launchTime}ms`);
    
    return activeStreams;
}

// ================== MAIN APPLICATION ==================
async function main() {
    console.log('\n' + '='.repeat(60));
    console.log('🚀 3-STREAM FACEBOOK LIVE LAUNCHER');
    console.log('Creates 3 Facebook Live streams, waits 100ms, starts all');
    console.log('='.repeat(60) + '\n');
    
    // Get Facebook credentials
    console.log('🔑 FACEBOOK CREDENTIALS:');
    CONFIG.facebook.pageId = await askQuestion('   Page ID: ');
    CONFIG.facebook.accessToken = await askQuestion('   Page Access Token: ');
    
    console.log('\n' + '📊'.repeat(30));
    console.log('CONFIGURATION COMPLETE');
    console.log(`Page ID: ${CONFIG.facebook.pageId}`);
    console.log(`Streams to create: ${CONFIG.streams.count}`);
    console.log('📊'.repeat(30) + '\n');
    
    console.log('Press Enter to continue...');
    await new Promise(resolve => process.stdin.once('data', resolve));
    
    // Create and start all streams
    const activeStreams = await createAndStartAllStreams();
    
    if (activeStreams.length === 0) {
        console.log('\n❌ No streams are active');
        rl.close();
        return;
    }
    
    rl.close();
    
    // Display dashboard
    console.log('\n' + '📊'.repeat(20));
    console.log('LIVE STREAMS DASHBOARD');
    console.log('📊'.repeat(20));
    
    activeStreams.forEach(stream => {
        console.log(`\n${stream.id}. 📺 ${stream.name}`);
        console.log(`   🆔 Facebook ID: ${stream.facebookStream?.streamId || 'N/A'}`);
        console.log(`   🎥 Status: ${stream.ffmpegProcess?.isRunning ? '✅ RUNNING' : '❌ STOPPED'}`);
        console.log(`   📤 RTMPS: ${stream.facebookStream?.rtmpsUrl?.substring(0, 50) || 'N/A'}...`);
        console.log(`   📥 Source: ${stream.sourceUrl.substring(0, 50)}...`);
    });
    
    console.log('\n' + '🔄'.repeat(20));
    console.log(`${activeStreams.length} STREAMS LIVE`);
    console.log('Press Ctrl+C to stop all streams');
    console.log('🔄'.repeat(20) + '\n');
    
    // Monitor streams
    const monitorInterval = setInterval(() => {
        console.log(`\n🕒 ${new Date().toLocaleTimeString()} - Status:`);
        
        let runningCount = 0;
        activeStreams.forEach(stream => {
            const isRunning = stream.ffmpegProcess?.isRunning;
            if (isRunning) runningCount++;
            
            console.log(`   ${stream.id}. ${stream.name}: ${isRunning ? '✅' : '❌'}`);
        });
        
        console.log(`   📈 ${runningCount}/${activeStreams.length} streams active`);
    }, 30000);
    
    // Graceful shutdown
    process.on('SIGINT', () => {
        clearInterval(monitorInterval);
        
        console.log('\n' + '🛑'.repeat(20));
        console.log('STOPPING ALL STREAMS');
        console.log('🛑'.repeat(20));
        
        let stoppedCount = 0;
        
        activeStreams.forEach(stream => {
            if (stream.ffmpegProcess?.process) {
                try {
                    stream.ffmpegProcess.process.kill('SIGTERM');
                    console.log(`   🛑 Stopped: ${stream.name}`);
                    stoppedCount++;
                } catch (e) {
                    // Already stopped
                }
            }
        });
        
        console.log(`\n✅ Stopped ${stoppedCount} streams. Goodbye!\n`);
        process.exit(0);
    });
    
    // Keep application running
    await new Promise(() => {});
}

// ================== RUN APPLICATION ==================
if (import.meta.url === `file://${process.argv[1]}`) {
    console.log('🚀 Starting Facebook Live Stream Launcher...\n');
    
    main().catch(error => {
        console.error('\n💥 Application error:', error.message);
        process.exit(1);
    });
}

// ================== EXAMPLE USAGE ==================
/*
Run this script:

1. Enter Facebook Page ID and Access Token
2. Configure 3 streams (title + source URL for each)
3. Script creates 3 Facebook Live streams
4. Waits 100ms
5. Starts all 3 simultaneously

Example Facebook credentials:
  Page ID: 123456789012345
  Access Token: EAACEdEose0cBA... (from Facebook Developer)

Example stream configuration:
  Stream 1:
    Title: Sports Channel 1
    Source: http://dhoomtv.xyz/8zpo3GsVY7/beneficial2concern/274162
  
  Stream 2:
    Title: News Channel
    Source: https://example.com/live.m3u8
*/
