const fs = require('fs');
const { OpenAI } = require('openai');

const client = new OpenAI({
  baseURL: 'https://integrate.api.nvidia.com/v1',
  apiKey: process.env.OPENAI_API_KEY || "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"
});

async function run() {
  try {
    // Generate a tiny valid wave file (44 bytes header + a few bytes of silence)
    const wavHeader = Buffer.from('524946462400000057415645666d7420100000000100010044ac000088580100020010006461746100000000', 'hex');
    fs.writeFileSync('test.wav', wavHeader);
    
    const transcription = await client.audio.transcriptions.create({
      file: fs.createReadStream('test.wav'),
      model: 'openai/whisper' // guess
    });
    console.log("Success:", transcription.text);
  } catch (e) {
    console.error("Error:", e.message);
  }
}
run();
