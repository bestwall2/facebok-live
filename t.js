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

// ================== FIXED FFMPEG FUNCTION ==================
function startFFmpeg(inputUrl, rtmpsUrl, streamKey, name) {
    console.log(`🚀 [${streamKey}] Starting FFmpeg for "${name}"`);
    
    // TRY BOTH: First RTMPS, if fails try RTMP
    const args = [
        "-re", 
        "-i", inputUrl,
        "-map", "0:v:0", 
        "-map", "0:a:0",
        "-c:v", "libx264", 
        "-preset", "ultrafast",
        "-pix_fmt", "yuv420p", 
        "-r", "25", 
        "-g", "50",
        "-b:v", "2000k", 
        "-maxrate", "2000k", 
        "-bufsize", "4000k",
        "-c:a", "aac", 
        "-ar", "44100", 
        "-b:a", "96k", 
        "-ac", "2",
        "-f", "flv"
    ];
    
    // Try RTMP first (more reliable)
    const rtmpUrl = rtmpsUrl.replace('rtmps://', 'rtmp://');
    args.push(rtmpUrl);
    
    console.log(`   📤 Using: ${rtmpUrl.substring(0, 60)}...`);
    
    const ffmpeg = spawn("ffmpeg", args);

    // Detailed logging
    ffmpeg.stderr.on('data', (data) => {
        const msg = data.toString();
        if (msg.includes('Opening')) console.log(`   🔓 ${msg.substring(0, 80)}...`);
        if (msg.includes('frame=')) console.log(`   📊 ${msg.match(/frame=\s*\d+/)[0]}`);
        if (msg.includes('error') || msg.includes('fail')) {
            console.error(`   🔥 ERROR: ${msg.substring(0, 100)}`);
        }
    });

    ffmpeg.on('close', (code) => {
        console.log(`   🔴 FFmpeg exited with code ${code}`);
        if (code !== 0) {
            console.log(`   💡 Tip: Try running this manually to debug:`);
            console.log(`   ffmpeg -re -i "${inputUrl}" -c copy -f flv "${rtmpUrl.substring(0, 80)}..."`);
        }
    });

    return ffmpeg;
}

// ================== MAIN STREAM FUNCTION ==================
async function createAndStream(config) {
    console.log(`\n🎬 Setting up: ${config.name}`);
    
    try {
        // 1. Create Facebook stream
        console.log(`   📡 Creating Facebook Live...`);
        const response = await fetch(
            `https://graph.facebook.com/${CONFIG.facebook.apiVersion}/${CONFIG.facebook.pageId}/live_videos`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: config.name,
                    status: "UNPUBLISHED",
                    access_token: CONFIG.facebook.accessToken
                })
            }
        );
        
        const fbStream = await response.json();
        
        if (fbStream.error) {
            console.error(`   ❌ Facebook API error: ${fbStream.error.message}`);
            return null;
        }
        
        console.log(`   ✅ Stream ID: ${fbStream.id}`);
        console.log(`   🔗 RTMPS URL: ${fbStream.secure_stream_url.substring(0, 60)}...`);
        
        // 2. Start FFmpeg
        const ffmpegProcess = startFFmpeg(
            config.inputUrl,
            fbStream.secure_stream_url,
            config.key,
            config.name
        );
        
        // 3. Get DASH URL after delay
        await new Promise(resolve => setTimeout(resolve, 10000));
        
        const dashResponse = await fetch(
            `https://graph.facebook.com/v24.0/${fbStream.id}?fields=dash_preview_url&access_token=${CONFIG.facebook.accessToken}`
        );
        const dashData = await dashResponse.json();
        
        return {
            key: config.key,
            name: config.name,
            facebookId: fbStream.id,
            dashUrl: dashData.dash_preview_url,
            ffmpegProcess: ffmpegProcess
        };
        
    } catch (error) {
        console.error(`   ❌ Setup failed: ${error.message}`);
        return null;
    }
}

// ================== MAIN APPLICATION ==================
async function main() {
    console.log('🚀 Facebook Multi-Stream Manager');
    console.log('='.repeat(50));
    
    const activeStreams = [];
    
    for (const config of CONFIG.streams) {
        const stream = await createAndStream(config);
        if (stream) {
            activeStreams.push(stream);
            
            console.log(`\n🎉 DASH URL FOR "${stream.name}":`);
            console.log(`🔗 ${stream.dashUrl}`);
            console.log('='.repeat(50));
            
            // Wait between streams
            if (config !== CONFIG.streams[CONFIG.streams.length - 1]) {
                console.log('\n⏸️  Waiting 3 seconds...\n');
                await new Promise(r => setTimeout(r, 3000));
            }
        }
    }
    
    // Monitor streams
    console.log('\n📊 ACTIVE STREAMS:');
    activeStreams.forEach(s => {
        console.log(`\n📺 ${s.name}`);
        console.log(`   🆔 ${s.facebookId}`);
        console.log(`   🔗 ${s.dashUrl.substring(0, 70)}...`);
        console.log(`   🎥 FFmpeg: ${s.ffmpegProcess.exitCode === null ? '✅ RUNNING' : '❌ STOPPED'}`);
    });
    
    console.log('\n🔄 Monitoring streams... Press Ctrl+C to stop\n');
    
    // Keep running
    process.on('SIGINT', () => {
        console.log('\n🛑 Stopping all streams...');
        activeStreams.forEach(s => {
            if (s.ffmpegProcess.exitCode === null) {
                s.ffmpegProcess.kill('SIGTERM');
                console.log(`   Stopped ${s.name}`);
            }
        });
        process.exit(0);
    });
    
    await new Promise(() => {});
}

// Run it
main().catch(console.error);
