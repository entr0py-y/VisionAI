const fetch = require('node-fetch');
const { createCanvas } = require('canvas');

async function run() {
  const canvas = createCanvas(1920, 1080);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'red';
  ctx.fillRect(0, 0, 1920, 1080);
  const b64 = canvas.toDataURL('image/jpeg', 0.85);

  const res = await fetch('http://localhost:3000/api/vision', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: b64, prompt: 'What is this?' })
  });
  console.log(res.status);
  console.log(await res.text());
}
run();
