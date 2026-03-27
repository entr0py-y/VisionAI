require('dotenv').config();
const { OpenAI } = require('openai');
const fs = require('fs');

const client = new OpenAI({
  baseURL: 'https://integrate.api.nvidia.com/v1',
  apiKey: "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"
});

async function run() {
  try {
    const response = await client.audio.transcriptions.create({
      file: fs.createReadStream("test.wav"),
      model: "whisper-large-v3",
    });
    console.log(response);
  } catch (err) {
    console.error(err.message);
  }
}
run();
