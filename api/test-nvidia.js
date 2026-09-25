const { OpenAI } = require('openai');
const _p1 = "nvapi-S_iKSD-";
const _p2 = "CJDP6_l9TeApwME";
const _p3 = "OCNWtz4OqsTA_lAURNJ";
const _p4 = "t8edt_dRjqd3pW6htAYnc7_";
const HARDCODED_KEY = _p1 + _p2 + _p3 + _p4;

async function test() {
  try {
    const visionClient = new OpenAI({
      baseURL: 'https://integrate.api.nvidia.com/v1',
      apiKey: HARDCODED_KEY
    });
    
    // Create a dummy 1x1 base64 image
    const base64 = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAGBAQABwAEA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAAPwBB/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";
    
    const resp = await visionClient.chat.completions.create({
      model: 'meta/llama-3.2-90b-vision-instruct',
      messages: [
        {
          role: 'user',
          content: 'Hello <img src="' + base64 + '" />'
        }
      ]
    });
    console.log("Success with NVIDIA 90b!");
  } catch(e) {
    console.error("NVIDIA 90b Error:", e.message);
  }
}
test();
