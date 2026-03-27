const fetch = require('node-fetch');
async function run() {
  const res = await fetch("http://localhost:3000/api/ai/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "what is in front of me", systemPrompt: "be brief" })
  });
  console.log("Status:", res.status);
  const reader = res.body;
  reader.on('data', (chunk) => {
    console.log("Chunk:", chunk.toString());
  });
  reader.on('end', () => console.log("Done"));
}
run();
