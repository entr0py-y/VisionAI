const { WaveFile } = require('wavefile');
const rawData = Buffer.alloc(1024); // 1024 bytes of silence
const base64Audio = rawData.toString('base64');

const pcmBuffer = Buffer.from(base64Audio, 'base64');
const wav = new WaveFile();
const int16Array = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.length / 2);
wav.fromScratch(1, 16000, '16', int16Array);
console.log('WAV Buffer size:', wav.toBuffer().length);
