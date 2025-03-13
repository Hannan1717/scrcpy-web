const express = require('express');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const http = require('http');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const net = require('net');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Store active sessions
const activeSessions = new Map();

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/streams', express.static('temp'));

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

    // Use a random port between 27000-28000 for scrcpy
    const port = 27000 + Math.floor(Math.random() * 1000);

    // Use scrcpy's --tcpip mode to stream directly to a socket
    const scrcpyProcess = spawn('scrcpy', [
        '-s', deviceId,
        '--no-audio',
        '--video-encoder', 'OMX.google.h264.encoder', // Try the Google encoder
        '--max-size', '640',
        '--video-bit-rate', '1M',
        '--max-fps', '15',
        '--port', port.toString(),
        '--tcpip'
    ]);

    scrcpyProcess.stderr.on('data', (data) => {
        console.log(`scrcpy: ${data.toString()}`);
    });

    // Give scrcpy a moment to start
    setTimeout(() => {
        // Now start ffmpeg to receive the stream and convert to HLS
        const ffmpegProcess = spawn('ffmpeg', [
            '-y',
            '-v', 'verbose',  // Add verbose logging
            '-i', `tcp://127.0.0.1:${port}`,
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-tune', 'zerolatency',
            '-f', 'mpegts',
            '-hls_time', '1',
            '-hls_list_size', '3',
            '-hls_flags', 'delete_segments+append_list',
            '-hls_segment_filename', path.join(outputDir, 'segment%03d.ts'),
            path.join(outputDir, 'playlist.m3u8')
        ]);
        ffmpegProcess.stderr.on('data', (data) => {
            console.log(`ffmpeg: ${data.toString()}`);
        });

        // Store session info
        activeSessions.set(sessionId, {
            deviceId,
            scrcpyProcess,
            ffmpegProcess,
            outputDir,
            port,
            clients: new Set()
        });

        res.json({
            success: true,
            sessionId,
            hlsUrl: `/streams/${sessionId}/playlist.m3u8`
        });
    }, 2000); // Wait 2 seconds for scrcpy to start
});

// API to stop session
app.post('/api/stop-session', (req, res) => {
    const { sessionId } = req.body;
    const session = activeSessions.get(sessionId);

    if (session) {
        session.scrcpyProcess.kill();
        session.ffmpegProcess.kill();
        activeSessions.delete(sessionId);

        // Clean up files
        setTimeout(() => {
            try {
                fs.rmSync(session.outputDir, { recursive: true, force: true });
            } catch (err) {
                console.error(`Error cleaning up: ${err}`);
            }
        }, 1000);

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
                    const adbArgs = adbCommand.split(' ');
                    const adbProcess = spawn('adb', adbArgs);
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