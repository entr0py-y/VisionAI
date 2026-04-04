const WebSocket = require('ws');
const ws = new WebSocket('wss://visionai-hig1.onrender.com/api/pi/ws');

ws.on('open', function open() {
  console.log('Connected');
  ws.send('{"type":"sensors","u":50,"p":0,"i":0,"mode":"IDLE"}');
});

ws.on('close', function close() {
  console.log('Disconnected');
});

ws.on('error', function error(err) {
  console.error('Error:', err);
});
