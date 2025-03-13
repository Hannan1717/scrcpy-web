const express = require('express');
const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
// const wss = new WebSocket.Server({ server });
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const ffmpeg = require('fluent-ffmpeg');

// Simpan informasi sesi aktif
const activeSessions = new Map();

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Gunakan WebSocket untuk streaming video frames
// const streamWss = new WebSocket.Server({ noServer: true });

// Handle WebSocket upgrade untuk streaming
// server.on('upgrade', (request, socket, head) => {
//     const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;

//     if (pathname === '/stream') {
//         streamWss.handleUpgrade(request, socket, head, (ws) => {
//             streamWss.emit('connection', ws, request);
//         });
//     } else if (pathname === '/control') {
//         wss.handleUpgrade(request, socket, head, (ws) => {
//             wss.emit('connection', ws, request);
//         });
//     } else {
//         socket.destroy();
//     }
// });

// Initialize separate WebSocket servers with path-specific configurations
const wss = new WebSocket.Server({
    noServer: true
});

const streamWss = new WebSocket.Server({
    noServer: true
});

// Handle upgrade requests
server.on('upgrade', (request, socket, head) => {
    try {
        // Parse the URL safely
        const url = new URL(request.url, `http://${request.headers.host}`);
        const pathname = url.pathname;

        if (pathname === '/stream') {
            streamWss.handleUpgrade(request, socket, head, (ws) => {
                const sessionId = url.searchParams.get('sessionId');
                if (!sessionId || !activeSessions.has(sessionId)) {
                    ws.close();
                    return;
                }

                const session = activeSessions.get(sessionId);
                session.streamClients.add(ws);

                console.log(`New stream client connected for session ${sessionId}`);

                ws.on('close', () => {
                    session.streamClients.delete(ws);
                    console.log(`Stream client disconnected from session ${sessionId}`);
                });

                streamWss.emit('connection', ws, request);
            });
        } else if (pathname === '/control') {
            wss.handleUpgrade(request, socket, head, (ws) => {
                const sessionId = url.searchParams.get('sessionId');
                if (!sessionId || !activeSessions.has(sessionId)) {
                    ws.close();
                    return;
                }

                const session = activeSessions.get(sessionId);
                session.clients.add(ws);

                console.log(`New control client connected for session ${sessionId}`);

                // Handle input control from client
                ws.on('message', (message) => {
                    try {
                        const data = JSON.parse(message);

                        if (data.type === 'input') {
                            // Forward command to device using ADB
                            const adbCommand = getAdbCommand(data.action, session.deviceId);
                            if (adbCommand) {
                                const adbProcess = spawn('adb', adbCommand.split(' '));
                                adbProcess.on('error', (error) => {
                                    console.error('ADB command error:', error);
                                });
                            }
                        }
                    } catch (e) {
                        console.error('Error processing message:', e);
                    }
                });

                ws.on('close', () => {
                    session.clients.delete(ws);
                    console.log(`Control client disconnected from session ${sessionId}`);
                });

                wss.emit('connection', ws, request);
            });
        } else {
            socket.destroy();
        }
    } catch (error) {
        console.error('Error handling WebSocket upgrade:', error);
        socket.destroy();
    }
});

// Remove the separate WebSocket connection handlers since they're now integrated above


// API untuk mendapatkan daftar perangkat
app.get('/api/devices', (req, res) => {
    const { exec } = require('child_process');

    exec('adb devices', (error, stdout, stderr) => {
        if (error) {
            console.error(`exec error: ${error}`);
            return res.status(500).json({ error: 'Failed to get devices' });
        }

        // Parse output dari adb devices
        const lines = stdout.trim().split('\n');
        const devices = [];

        // Lewati baris pertama (header)
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

// API untuk memulai sesi scrcpy
app.post('/api/start-session', (req, res) => {
    const deviceId = req.body.deviceId;
    const sessionId = Math.random().toString(36).substr(2, 9);
    const port = 27183; // Choose a random port or make this dynamic

    // Create temporary directory for outputs
    const outputDir = path.resolve(__dirname, `./temp/${sessionId}`);
    fs.mkdirSync(outputDir, { recursive: true });

    // Start scrcpy with video forwarding over TCP
    const scrcpyProcess = spawn('scrcpy', [
        '-s', deviceId,
        '--video-bit-rate=2M',
        '--max-fps=30',
        '--crop=1080:1920:0:0',  // Adjust to your device resolution
        '--no-display',          // Don't display on the host machine
        '--tcpip',               // Enable forwarding video stream over TCP
        `--video-codec=h264`,    // Specify video codec
        `--port=${port}`         // Port for TCP connection
    ]);

    scrcpyProcess.stdout.on('data', (data) => {
        console.log(`scrcpy stdout: ${data}`);
    });

    scrcpyProcess.stderr.on('data', (data) => {
        console.error(`scrcpy stderr: ${data}`);
    });

    // Use ffmpeg to connect to the TCP port and generate frames
    const ffmpegProcess = spawn('ffmpeg', [
        '-i', `tcp://127.0.0.1:${port}`,
        '-f', 'image2pipe',
        '-vcodec', 'mjpeg',
        '-q:v', '3',
        '-vf', 'fps=10',  // 10 frames per second
        '-'
    ], {
        stdio: ['ignore', 'pipe', 'pipe']
    });

    ffmpegProcess.stderr.on('data', (data) => {
        console.error(`ffmpeg stderr: ${data}`);
    });

    // Store session information
    activeSessions.set(sessionId, {
        deviceId,
        port,
        scrcpyProcess,
        ffmpegProcess,
        outputDir,
        clients: new Set(),
        streamClients: new Set()
    });

    // Process frames from ffmpeg output
    let imageBuffer = [];
    ffmpegProcess.stdout.on('data', (chunk) => {
        imageBuffer.push(chunk);

        // Look for JPEG header (FFD8) and footer (FFD9) to determine complete frames
        const buffer = Buffer.concat(imageBuffer);
        let startIndex = 0;
        let endIndex = -1;

        while (true) {
            startIndex = buffer.indexOf(Buffer.from([0xFF, 0xD8]), startIndex);
            if (startIndex === -1) break;

            endIndex = buffer.indexOf(Buffer.from([0xFF, 0xD9]), startIndex);
            if (endIndex === -1) break;

            // We have a complete frame
            const frameBuffer = buffer.slice(startIndex, endIndex + 2);

            // Send frame to all clients
            const session = activeSessions.get(sessionId);
            if (session) {
                session.streamClients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(frameBuffer);
                    }
                });
            }

            startIndex = endIndex + 2;
        }

        // Save remaining buffer for processing with next chunk
        if (startIndex > 0) {
            imageBuffer = [buffer.slice(startIndex)];
        }
    });

    res.json({ success: true, sessionId });
});

// Koneksi WebSocket untuk streaming video
streamWss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const sessionId = url.searchParams.get('sessionId');

    if (!sessionId || !activeSessions.has(sessionId)) {
        ws.close();
        return;
    }

    const session = activeSessions.get(sessionId);
    session.streamClients.add(ws);

    console.log(`New stream client connected for session ${sessionId}`);

    ws.on('close', () => {
        session.streamClients.delete(ws);
        console.log(`Stream client disconnected from session ${sessionId}`);
    });
});

// Menangani koneksi WebSocket untuk kontrol input
wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const sessionId = url.searchParams.get('sessionId');

    if (!sessionId || !activeSessions.has(sessionId)) {
        ws.close();
        return;
    }

    const session = activeSessions.get(sessionId);
    session.clients.add(ws);

    console.log(`New control client connected for session ${sessionId}`);

    // Tangani input kontrol dari klien
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            if (data.type === 'input') {
                // Teruskan perintah ke perangkat menggunakan ADB
                const adbCommand = getAdbCommand(data.action, session.deviceId);
                if (adbCommand) {
                    const adbProcess = spawn('adb', adbCommand.split(' '));
                    adbProcess.on('error', (error) => {
                        console.error('ADB command error:', error);
                    });
                }
            }
        } catch (e) {
            console.error('Error processing message:', e);
        }
    });

    ws.on('close', () => {
        session.clients.delete(ws);
        console.log(`Control client disconnected from session ${sessionId}`);
    });
});

// API untuk menghentikan sesi
app.post('/api/stop-session', (req, res) => {
    const { sessionId } = req.body;
    const session = activeSessions.get(sessionId);

    if (session) {
        // Hentikan proses scrcpy
        if (session.scrcpyProcess) {
            session.scrcpyProcess.kill();
        }

        // Hentikan proses ffmpeg
        if (session.ffmpegProcess) {
            session.ffmpegProcess.kill();
        }

        // Hapus direktori sementara
        try {
            fs.rmSync(session.outputDir, { recursive: true, force: true });
        } catch (err) {
            console.error(`Error removing directory ${session.outputDir}:`, err);
        }

        activeSessions.delete(sessionId);
        res.json({ success: true });
    } else {
        res.status(404).json({ success: false, error: 'Session not found' });
    }
});

// Fungsi untuk mengubah aksi browser menjadi perintah ADB
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

server.listen(3000, () => {
    console.log('Server running on port 3000');
});