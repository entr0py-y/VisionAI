const fetch = require('node-fetch');

async function testStatus() {
  try {
    const response = await fetch('http://192.168.29.115:3000/api/pi/status');
    const data = await response.text();
    console.log("Status check:", data);
  } catch(e) {
    console.error(e);
  }
}

testStatus();
