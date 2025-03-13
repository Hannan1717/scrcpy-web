// public/app.js
let currentDeviceId = null;
let currentSessionId = null;
let controlWs = null;
let videoPlayer = null;

// Get device list
async function getDevices() {
    try {
        const response = await fetch('http://127.0.0.1:3000/api/devices');
        const data = await response.json();

        const devicesElement = document.getElementById('devices');
        devicesElement.innerHTML = '';

        if (data.devices.length === 0) {
            devicesElement.innerHTML = '<p>Tidak ada perangkat terhubung</p>';
            return;
        }

        data.devices.forEach(device => {
            const deviceElement = document.createElement('div');
            deviceElement.classList.add('device-item');
            deviceElement.innerHTML = `
                <span>${device.id}</span>
                <button data-device-id="${device.id}">Kontrol</button>
            `;

            deviceElement.querySelector('button').addEventListener('click', () => {
                startSession(device.id);
            });

            devicesElement.appendChild(deviceElement);
        });
    } catch (error) {
        console.error('Error getting devices:', error);
    }
}

// Start scrcpy session
async function startSession(deviceId) {
    try {
        // Stop previous session if exists
        if (currentSessionId) {
            await fetch('/api/stop-session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId: currentSessionId })
            });

            if (controlWs) {
                controlWs.close();
                controlWs = null;
            }

            if (videoPlayer) {
                videoPlayer.pause();
                videoPlayer.src = '';
                videoPlayer = null;
            }
        }

        // Start new session
        const response = await fetch('/api/start-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceId })
        });

        const data = await response.json();

        if (data.success) {
            currentDeviceId = deviceId;
            currentSessionId = data.sessionId;
            document.getElementById('device-title').textContent = `Perangkat: ${deviceId}`;

            // Start HLS streaming
            startStreaming(data.sessionId, data.hlsUrl);

            // Connect control WebSocket
            connectControlWs(data.sessionId);
        }
    } catch (error) {
        console.error('Error starting session:', error);
    }
}

// Start screen streaming with HLS
function startStreaming(sessionId, hlsUrl) {
    const screenContainer = document.getElementById('device-screen');
    screenContainer.innerHTML = '';

    // Create video element
    const video = document.createElement('video');
    video.id = 'device-video';
    video.controls = false;
    video.autoplay = true;
    video.style.width = '100%';
    video.style.height = 'auto';

    screenContainer.appendChild(video);

    // Make sure hls.js is loaded
    if (Hls.isSupported()) {
        const hls = new Hls({
            debug: false,
            enableWorker: true,
            lowLatencyMode: true,
            backBufferLength: 0
        });

        hls.loadSource(hlsUrl);
        hls.attachMedia(video);

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
            video.play();
        });

        videoPlayer = video;
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        // For Safari which has native HLS support
        video.src = hlsUrl;
        video.addEventListener('loadedmetadata', () => {
            video.play();
        });

        videoPlayer = video;
    } else {
        screenContainer.innerHTML = '<p>Your browser does not support HLS streaming</p>';
    }

    // Handle user interaction
    screenContainer.addEventListener('click', (event) => {
        if (!video) return;

        const rect = video.getBoundingClientRect();
        const scaleX = 1080 / rect.width; // Assuming device width is 1080px
        const scaleY = 2400 / rect.height; // Assuming device height is 2400px

        const x = Math.round((event.clientX - rect.left) * scaleX);
        const y = Math.round((event.clientY - rect.top) * scaleY);

        sendCommand({ type: 'tap', x, y });
    });
}

// Connect to control WebSocket
function connectControlWs(sessionId) {
    controlWs = new WebSocket(`ws://${window.location.host}/ws?sessionId=${sessionId}`);

    controlWs.onerror = (error) => {
        console.error('Control WebSocket error:', error);
    };
}

// Send command to device
function sendCommand(action) {
    if (controlWs && controlWs.readyState === WebSocket.OPEN) {
        controlWs.send(JSON.stringify({
            type: 'input',
            action
        }));
    }
}

// Set up event listeners
document.addEventListener('DOMContentLoaded', () => {
    // Fetch connected devices when page loads
    getDevices();

    // Button to refresh device list
    document.getElementById('refresh-devices').addEventListener('click', getDevices);

    // Control buttons (e.g., volume buttons, home button, etc.)
    document.querySelectorAll('.control-buttons button').forEach(button => {
        button.addEventListener('click', () => {
            const keyCode = button.getAttribute('data-key');
            sendCommand({ type: 'key', keyCode: parseInt(keyCode) });
        });
    });

    // Send text button
    document.getElementById('send-text').addEventListener('click', () => {
        const text = document.getElementById('text-input').value;
        if (text) {
            sendCommand({ type: 'text', text });
            document.getElementById('text-input').value = '';
        }
    });
});