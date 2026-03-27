const fs = require('fs');

async function test() {
  const FormData = require('form-data');
  const fetch = require('node-fetch');
  
  const form = new FormData();
  form.append('file', fs.createReadStream('test.wav'));
  form.append('model', 'whisper-large-v3');

  const response = await fetch('https://integrate.api.nvidia.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer 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`,
      ...form.getHeaders()
    },
    body: form
  });

  const text = await response.text();
  console.log(response.status);
  console.log(text);
}
test();
