const fetch = require('node-fetch');

async function run() {
  const fetch = require('node-fetch');
  // Just send a very long invalid base64 string to see if the server returns 500 unconditionally 
  // Wait, let's just make an HTTP request to an image online, convert it to base64, and send it.
  const imgRes = await fetch('https://images.unsplash.com/photo-1628157588553-5eeea00af15c?q=80&w=2680&auto=format&fit=crop');
  const buffer = await imgRes.buffer();
  const b64 = 'data:image/jpeg;base64,' + buffer.toString('base64');
  console.log('Sending size:', b64.length);

  const res = await fetch('http://localhost:3000/api/vision', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: b64, prompt: 'What is this?' })
  });
  console.log(res.status);
  console.log(await res.text());
}
run();
