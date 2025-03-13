const express = require('express');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const http = require('http');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Store active sessions
const activeSessions = new Map();

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/streams', express.static('temp')); // Serve the stream files statically

// Make sure temp directory exists
if (!fs.existsSync('./temp')) {
    fs.mkdirSync('./temp');
}

// API to get device list
app.get('/api/devices', (req, res) => {
    const { exec } = require('child_process');

    exec('adb devices', (error, stdout, stderr) => {
        if (error) {
            console.error(`exec error: ${error}`);
            return res.status(500).json({ error: 'Failed to get devices' });
        }

        // Parse output from adb devices
        const lines = stdout.trim().split('\n');
        const devices = [];

        // Skip first line (header)
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line) {
                const [id, status] = line.split('\t');
                devices.push({ id, status });
            }
        }

        res.json({ devices });
    });
});

// API to start scrcpy session
app.post('/api/start-session', (req, res) => {
    const deviceId = req.body.deviceId;
    const sessionId = Math.random().toString(36).substr(2, 9);

    // Create temp directory for this session
    const outputDir = path.join('./temp', sessionId);
    fs.mkdirSync(outputDir, { recursive: true });

    // HLS segment directory
    const segmentDir = path.join(outputDir, 'segments');
    fs.mkdirSync(segmentDir, { recursive: true });

    // Start scrcpy with output to a file for ffmpeg to process
    const scrcpyProcess = spawn('scrcpy', [
        '-s', deviceId,
        '--no-display',
        '--stay-awake',
        '--video-bit-rate', '2M',
        '--max-fps', '30'
    ], {
        stdio: ['ignore', 'pipe', 'pipe']
    });

    const getDeviceResolution = (deviceId) => {
        return new Promise((resolve, reject) => {
            exec(`adb -s ${deviceId} shell wm size`, (error, stdout) => {
                if (error) {
                    return reject(error);
                }
                // Parse output like "Physical size: 1080x2400"
                const match = stdout.match(/Physical size: (\d+)x(\d+)/);
                if (match) {
                    resolve({
                        width: parseInt(match[1]),
                        height: parseInt(match[2])
                    });
                } else {
                    reject(new Error('Could not determine device resolution'));
                }
            });
        });
    };

    getDeviceResolution(deviceId)
        .then((resolution) => {
            console.log(`Resolution: ${resolution}`);
        })
        .catch((error) => {
            console.error('Error:', error);
        });
    // Capture stdout from scrcpy and pipe it to ffmpeg
    const ffmpegProcess = spawn('ffmpeg', [
        '-y',
        '-f', 'rawvideo',
        '-pixel_format', 'bgr0',
        '-video_size', '1080x2400', // Update with your device's resolution
        '-framerate', '30',
        '-i', 'pipe:0',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-f', 'hls',
        '-hls_time', '1',
        '-hls_list_size', '3',
        '-hls_flags', 'delete_segments',
        '-hls_segment_filename', path.join(segmentDir, 'segment%03d.ts'),
        path.join(outputDir, 'playlist.m3u8')
    ]);

    // Pipe scrcpy stdout to ffmpeg stdin
    scrcpyProcess.stdout.pipe(ffmpegProcess.stdin);

    // Log errors
    scrcpyProcess.stderr.on('data', (data) => {
        console.error(`scrcpy error: ${data}`);
    });

    ffmpegProcess.stderr.on('data', (data) => {
        console.log(`ffmpeg: ${data}`);
    });

    // Store session info
    activeSessions.set(sessionId, {
        deviceId,
        scrcpyProcess,
        ffmpegProcess,
        outputDir,
        clients: new Set()
    });

    res.json({
        success: true,
        sessionId,
        hlsUrl: `/streams/${sessionId}/playlist.m3u8`
    });
});

// app.post('/api/start-session', async (req, res) => {
//     const deviceId = req.body.deviceId;
//     const sessionId = Math.random().toString(36).substr(2, 9);

//     try {
//         // Create temp directory for this session
//         const outputDir = path.join('./temp', sessionId);
//         fs.mkdirSync(outputDir, { recursive: true });

//         // HLS segment directory
//         const segmentDir = path.join(outputDir, 'segments');
//         fs.mkdirSync(segmentDir, { recursive: true });

//         // Create a named pipe (fifo) for streaming
//         const videoPath = path.join(outputDir, 'video.mp4');

//         // Start scrcpy with direct video output
//         const scrcpyProcess = spawn('scrcpy', [
//             '-s', deviceId,
//             '--no-display',
//             '--record', videoPath,
//             '--stay-awake',
//             '--video-bit-rate', '2M',
//             '--max-fps', '30'
//         ]);

//         // Listen for recording started message
//         scrcpyProcess.stderr.on('data', (data) => {
//             const output = data.toString();
//             console.log(`scrcpy: ${output}`);

//             if (output.includes('Recording started')) {
//                 // Start ffmpeg to process the video file as it's being written
//                 const ffmpegProcess = spawn('ffmpeg', [
//                     '-y',
//                     '-i', videoPath,
//                     '-c:v', 'libx264',
//                     '-preset', 'ultrafast',
//                     '-tune', 'zerolatency',
//                     '-f', 'hls',
//                     '-hls_time', '1',
//                     '-hls_list_size', '3',
//                     '-hls_flags', 'delete_segments+append_list',
//                     '-hls_segment_filename', path.join(segmentDir, 'segment%03d.ts'),
//                     path.join(outputDir, 'playlist.m3u8')
//                 ]);

//                 ffmpegProcess.stderr.on('data', (data) => {
//                     console.log(`ffmpeg: ${data}`);
//                 });

//                 // Store session info
//                 activeSessions.set(sessionId, {
//                     deviceId,
//                     scrcpyProcess,
//                     ffmpegProcess,
//                     outputDir,
//                     clients: new Set()
//                 });
//             }
//         });

//         res.json({
//             success: true,
//             sessionId,
//             hlsUrl: `/streams/${sessionId}/playlist.m3u8`
//         });
//     } catch (error) {
//         console.error('Session start error:', error);
//         res.status(500).json({
//             success: false,
//             error: 'Failed to start session'
//         });
//     }
// });


// API to stop session
app.post('/api/stop-session', (req, res) => {
    const { sessionId } = req.body;
    const session = activeSessions.get(sessionId);

    if (session) {
        session.scrcpyProcess.kill();
        session.ffmpegProcess.kill();
        activeSessions.delete(sessionId);

        // Clean up files (optional - can keep them for debugging)
        // fs.rmSync(session.outputDir, { recursive: true, force: true });

        res.json({ success: true });
    } else {
        res.status(404).json({ success: false, error: 'Session not found' });
    }
});

// Handle WebSocket connections for device control
wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const sessionId = url.searchParams.get('sessionId');

    if (!sessionId || !activeSessions.has(sessionId)) {
        ws.close();
        return;
    }

    const session = activeSessions.get(sessionId);
    session.clients.add(ws);

    // Handle control input from client
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            if (data.type === 'input') {
                // Forward commands to device using ADB
                const adbCommand = getAdbCommand(data.action, session.deviceId);
                if (adbCommand) {
                    const adbProcess = spawn('adb', adbCommand.split(' '));
                    adbProcess.stderr.on('data', (data) => {
                        console.error(`adb error: ${data}`);
                    });
                }
            }
        } catch (error) {
            console.error('Error processing message:', error);
        }
    });

    ws.on('close', () => {
        session.clients.delete(ws);
    });
});

// Function to convert browser actions to ADB commands
function getAdbCommand(action, deviceId) {
    switch (action.type) {
        case 'tap':
            return `-s ${deviceId} shell input tap ${action.x} ${action.y}`;
        case 'swipe':
            return `-s ${deviceId} shell input swipe ${action.startX} ${action.startY} ${action.endX} ${action.endY} ${action.duration || 300}`;
        case 'key':
            return `-s ${deviceId} shell input keyevent ${action.keyCode}`;
        case 'text':
            return `-s ${deviceId} shell input text "${action.text.replace(/ /g, '%s')}"`;
        default:
            return '';
    }
}

// Run server
server.listen(3000, () => {
    console.log('Server running on port 3000');
});