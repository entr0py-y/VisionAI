const fs = require('fs');

async function test() {
  const fetch = require('node-fetch');
  
  const response = await fetch('https://ai.api.nvidia.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer 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`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      "audio": "base64...",
      "model": "canary"
    })
  });

  const text = await response.text();
  console.log(response.status);
  console.log(text);
}
test();
