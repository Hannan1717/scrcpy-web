// Membuat koneksi WebSocket
const WebSocket = require('ws');
const socket = new WebSocket('ws://localhost:3000');

// Ketika koneksi dibuka
socket.onopen = function (event) {
    console.log('WebSocket Terhubung');
    // Kirim pesan ke server
    socket.send('Hello Server!');
};

// Ketika menerima pesan dari server
socket.onmessage = function (event) {
    console.log('Pesan dari server: ' + event.data);
};

// Ketika koneksi ditutup
socket.onclose = function (event) {
    console.log('WebSocket Ditutup');
};

// Ketika terjadi error
socket.onerror = function (error) {
    console.error('WebSocket Error: ', error);
};
