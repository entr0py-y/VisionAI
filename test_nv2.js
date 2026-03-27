require('dotenv').config();
const OpenAI = require('openai').default;

const visionClient = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: 'https://integrate.api.nvidia.com/v1',
});

async function run() {
  try {
    const fs = require('fs');
    // dummy 1x1 base64
    const b64 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
    const resp = await visionClient.chat.completions.create({
      model: 'meta/llama-3.2-11b-vision-instruct',
      messages: [
        {
          role: 'user',
          content: `What is this? <img src="${b64}" />`
        }
      ],
      max_tokens: 512
    });
    console.log(resp.choices[0].message.content);
  } catch (e) {
    console.error(e.message);
  }
}
run();
