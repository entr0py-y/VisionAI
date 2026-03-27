const { OpenAI } = require('openai');
require('dotenv').config();

const HARDCODED_KEY = "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";

const deepseekClient = new OpenAI({ 
  baseURL: 'https://api.deepseek.com/v1', 
  apiKey: process.env.DEEPSEEK_API_KEY || "dummy" 
});

async function run() {
  try {
     console.log("Checking deepseek test")
  } catch(e) {}
}
run();
