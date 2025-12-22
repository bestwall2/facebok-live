import { spawn } from 'child_process';
import fetch from 'node-fetch';
import readline from 'readline';

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

// ================== MAIN APPLICATION ==================
async function main() {
    console.log('\n' + '='.repeat(60));
    console.log('🚀 MULTI-STREAM FFMPEG BROADCASTER');
    console.log('='.repeat(60) + '\n');

    // Ask how many streams
    const streamCount = parseInt(await askQuestion('📊 How many streams do you want to launch? '));
    
    if (isNaN(streamCount) || streamCount < 1) {
        console.log('❌ Please enter a valid number (1 or more)');
        rl.close();
        return;
    }

    const streams = [];

    // Collect stream information
    console.log('\n' + '📝'.repeat(20));
    console.log('ENTER STREAM DETAILS');
    console.log('📝'.repeat(20) + '\n');

    for (let i = 1; i <= streamCount; i++) {
        console.log(`\n📺 STREAM ${i}/${streamCount}:`);
        
        const name = await askQuestion(`   Enter stream name: `);
        const rtmpsUrl = await askQuestion(`   Enter RTMPS URL: `);
        const streamUrl = await askQuestion(`   Enter source stream URL (M3U8/MP4/etc): `);
        
        streams.push({
            id: i,
            name: name || `Stream ${i}`,
            rtmpsUrl: rtmpsUrl,
            streamUrl: streamUrl,
            ffmpegProcess: null,
            status: 'READY'
        });

        console.log(`   ✅ Stream ${i} configured!`);
    }

    rl.close();

    console.log('\n' + '🚀'.repeat(20));
    console.log('STARTING ALL STREAMS');
    console.log('🚀'.repeat(20) + '\n');

    // Start all streams
    const activeStreams = [];

    for (const stream of streams) {
        try {
            console.log(`\n🎬 Launching: ${stream.name}`);
            console.log(`   📤 Destination: ${stream.rtmpsUrl.substring(0, 70)}...`);
            console.log(`   📥 Source: ${stream.streamUrl}`);

            const ffmpegProcess = startFFmpegStream(
                stream.streamUrl,
                stream.rtmpsUrl,
                stream.id,
                stream.name
            );

            stream.ffmpegProcess = ffmpegProcess;
            stream.status = 'RUNNING';
            activeStreams.push(stream);

            console.log(`   ✅ Stream started successfully!`);
            
            // Small delay between starting streams
            if (stream.id < streamCount) {
                await new Promise(resolve => setTimeout(resolve, 2000));
            }

        } catch (error) {
            console.error(`   ❌ Failed to start ${stream.name}: ${error.message}`);
            stream.status = 'FAILED';
        }
    }

    // Display final status
    console.log('\n' + '📊'.repeat(20));
    console.log('STREAM STATUS DASHBOARD');
    console.log('📊'.repeat(20));

    activeStreams.forEach(stream => {
        console.log(`\n${stream.id}. 📺 ${stream.name}`);
        console.log(`   🎥 Status: ${stream.status}`);
        console.log(`   📤 RTMPS: ${stream.rtmpsUrl.substring(0, 50)}...`);
        console.log(`   📥 Source: ${stream.streamUrl.substring(0, 50)}...`);
    });

    console.log('\n' + '🔄'.repeat(20));
    console.log('ALL STREAMS ARE NOW RUNNING');
    console.log('Press Ctrl+C to stop all streams');
    console.log('🔄'.repeat(20) + '\n');

    // Monitor streams
    const monitorInterval = setInterval(() => {
        console.log(`\n🕒 ${new Date().toLocaleTimeString()} - Stream Status:`);
        
        activeStreams.forEach(stream => {
            const isRunning = stream.ffmpegProcess?.exitCode === null;
            stream.status = isRunning ? 'RUNNING' : 'STOPPED';
            
            console.log(`   ${stream.id}. ${stream.name}: ${isRunning ? '✅' : '❌'} ${stream.status}`);
        });
        
        console.log('\nPress Ctrl+C to exit');
    }, 30000);

    // Graceful shutdown
    process.on('SIGINT', () => {
        clearInterval(monitorInterval);
        
        console.log('\n' + '🛑'.repeat(20));
        console.log('STOPPING ALL STREAMS');
        console.log('🛑'.repeat(20));
        
        let stoppedCount = 0;
        
        activeStreams.forEach(stream => {
            if (stream.ffmpegProcess && stream.ffmpegProcess.exitCode === null) {
                stream.ffmpegProcess.kill('SIGTERM');
                console.log(`   🛑 Stopped: ${stream.name}`);
                stoppedCount++;
            }
        });
        
        console.log(`\n✅ Stopped ${stoppedCount} streams. Goodbye!\n`);
        process.exit(0);
    });

    // Keep application running
    await new Promise(() => {});
}

// ================== FFMPEG STREAM FUNCTION ==================
function startFFmpegStream(sourceUrl, rtmpsUrl, streamId, name) {
    console.log(`   🚀 Starting FFmpeg for "${name}"...`);
    
    const args = [
        "-re",                    // Read input at native frame rate
        "-i", sourceUrl,          // Input source URL
        "-c", "copy",             // Copy codec (no re-encoding)
        "-f", "flv",              // Output format
        rtmpsUrl                  // RTMPS destination
    ];
    
    const ffmpeg = spawn("ffmpeg", args);
    
    // Log FFmpeg output
    ffmpeg.stderr.on('data', (data) => {
        const msg = data.toString();
        
        // Show initial connection
        if (msg.includes('Opening') && msg.includes('output')) {
            console.log(`   🔓 ${name}: Connected to RTMPS server`);
        }
        
        // Show progress (every 100 frames)
        if (msg.includes('frame=')) {
            const frameMatch = msg.match(/frame=\s*(\d+)/);
            const timeMatch = msg.match(/time=([\d:.]+)/);
            if (frameMatch && timeMatch && parseInt(frameMatch[1]) % 100 === 0) {
                console.log(`   📊 ${name}: Frame ${frameMatch[1]}, Time ${timeMatch[1]}`);
            }
        }
        
        // Show errors
        if (msg.includes('error') || msg.includes('fail') || msg.includes('Invalid')) {
            console.error(`   🔥 ${name} error: ${msg.substring(0, 100)}`);
        }
    });
    
    ffmpeg.on('close', (code) => {
        console.log(`   🔴 ${name}: FFmpeg exited with code ${code}`);
    });
    
    return ffmpeg;
}

// ================== RUN APPLICATION ==================
main().catch(error => {
    console.error('💥 Application error:', error);
    process.exit(1);
});
