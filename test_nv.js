require('dotenv').config();
const OpenAI = require('openai').default;

const visionClient = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY, // NVIDIA API key shared
  baseURL: 'https://integrate.api.nvidia.com/v1',
});

async function run() {
  try {
    const resp = await visionClient.chat.completions.create({
      model: 'meta/llama-3.2-11b-vision-instruct',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            { type: 'image_url', image_url: { url: 'https://upload.wikimedia.org/wikipedia/commons/a/a7/React-icon.svg' } },
          ],
        },
      ],
    });
    console.log(resp.choices[0].message.content);
  } catch (e) {
    console.error(e.message);
  }
}
run();
