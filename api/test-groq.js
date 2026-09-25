require('dotenv').config({ path: '../.env' });
const { OpenAI } = require('openai');

async function test() {
  try {
    const groqVisionClient = new OpenAI({
      baseURL: 'https://api.groq.com/openai/v1',
      apiKey: process.env.GROQ_API_KEY || "gsk_..." // I don't know the full key, it's on Render
    });
    // Can't run it locally without the key.
  } catch(e) {}
}
