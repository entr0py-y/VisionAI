const fetch = require('node-fetch');
async function run() {
  const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNiAAAABgADNjd8qAAAAABJRU5ErkJggg==";
  const res = await fetch('http://localhost:3000/api/vision', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: b64, prompt: 'What is this?' })
  });
  console.log(res.status);
  console.log(await res.text());
}
run();
