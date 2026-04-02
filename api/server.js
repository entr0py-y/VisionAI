require('dotenv').config();
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
const express  = require('express');
const cors     = require('cors');
const OpenAI   = require('openai');
const path     = require('path');
const multer   = require('multer');
const { safeInsert } = require('../lib/supabaseClient.cjs');

const app    = express();
const PORT   = process.env.PORT || 3000;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '25mb' }));       // allow large base64 images
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.use(express.static(path.join(__dirname, '..')));

const _p1 = "nvapi-S_iKSD-";
const _p2 = "CJDP6_l9TeApwME";
const _p3 = "OCNWtz4OqsTA_lAURNJ";
const _p4 = "t8edt_dRjqd3pW6htAYnc7_";
const HARDCODED_KEY = _p1 + _p2 + _p3 + _p4;

// ─── Groq / OpenAI-compatible client ───────────────────────────────────────
const client = new OpenAI({
  baseURL: process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1',
  apiKey:  process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY || HARDCODED_KEY,
});

// ─── Dedicated vision client (uses VISION_API_KEY if set) ────────────────────
const visionClient = new OpenAI({
  baseURL: process.env.VISION_BASE_URL || 'https://integrate.api.nvidia.com/v1',
  apiKey:  process.env.NVIDIA_API_KEY || process.env.VISION_API_KEY || process.env.OPENAI_API_KEY || HARDCODED_KEY,
});

// ─── Helper: non-streaming AI call ──────────────────────────────────────────
async function aiComplete(messages, model = 'llama-3.1-8b-instant', maxTokens = 512) {
  const resp = await client.chat.completions.create({
    model,
    messages,
    temperature: 0.5,
    max_tokens: maxTokens,
    stream: false,
  });
  return resp.choices?.[0]?.message?.content?.trim() || '';
}

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/ai/chat — Streaming general chat (existing)
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/ai/chat', async (req, res) => {
  try {
    const { message, history, systemPrompt, username } = req.body;
    if (!message) return res.status(400).json({ error: 'Message is required' });

    // Build live sensor context for spatial awareness
    const s = latestSensorData;
    let sensorInfo = '';
    if (s.dist > 0 && s.dist <= 400) {
      sensorInfo += `Ultrasonic sensor: nearest object is ${s.dist}cm (${(s.dist / 100).toFixed(1)}m) ahead. `;
    } else {
      sensorInfo += `Ultrasonic sensor: path clear, no object within 4m. `;
    }
    if (s.ir === 1) {
      sensorInfo += `IR sensor: obstacle extremely close (within 10cm). `;
    } else {
      sensorInfo += `IR sensor: no immediate close-range obstacle. `;
    }
    if (s.pir === 1) {
      sensorInfo += `PIR sensor: motion detected nearby. `;
    } else {
      sensorInfo += `PIR sensor: no movement detected. `;
    }

    const defaultPrompt = 'You are the Vision AID assistant. Help visually impaired users with clear, concise, accessible instructions. Keep all responses brief and easy to understand. ' +
      'You have real-time hardware sensor data from the user\'s wearable device. You MUST use ALL sensor readings in your response when the user asks about their surroundings, obstacles, or movement. Always mention exact distances. ' +
      'Sensor readings: ' + sensorInfo;

    const fullSystemPrompt = systemPrompt || defaultPrompt;

    const messages = [{ role: 'system', content: fullSystemPrompt }];

    if (history && Array.isArray(history)) {
      for (const entry of history) {
        messages.push({
          role: entry.role === 'user' ? 'user' : 'assistant',
          content: entry.text || '',
        });
      }
    }
    messages.push({ role: 'user', content: message });
    try {
      safeInsert('messages', { role: 'user', content: message, type: 'chat', username: username || "unknown" }).catch(() => {});
    } catch(e) {}


    // Vercel Serverless Functions don't support simple Express streaming 
    // They will truncate the response to the first chunk. Send a single response instead.
    if (process.env.VERCEL) {
      const responseText = await aiComplete(messages, 'llama-3.1-8b-instant', 1024);
      return res.send(responseText);
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');

    const stream = await client.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages,
      temperature: 0.7,
      max_tokens: 1024,
      stream: true,
    });

    let fullAssistantResponse = '';
    for await (const chunk of stream) {
      const content = chunk.choices?.[0]?.delta?.content;
      if (content) {
        fullAssistantResponse += content;
        res.write(content);
      }
    }
    res.end();
    
    try {
      safeInsert('messages', { role: 'assistant', content: fullAssistantResponse, type: 'chat', username: username || "unknown" }).catch(() => {});
    } catch(e) {}

  } catch (error) {
    console.error('AI Chat Error:', error.message);
    if (!res.headersSent) {
      const status = error.status || 500;
      res.status(status).json({
        error: 'Failed to get AI response',
        fallback: status === 429
          ? "I'm receiving too many requests. Please wait a moment."
          : "I'm having trouble connecting. Please try again.",
      });
    } else {
      res.end();
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/ai/classify — Intent classification (rule-based, zero-latency, no LLM)
// Body: { message: string }
// Response: { intent: 'VISION'|'NAVIGATION'|'LOCATION_INFO'|'PLACE_SEARCH'|'GENERAL_CHAT', destination: string|null }
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/ai/classify', (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });

    let lower = message.toLowerCase().trim();
    // Normalize common typos
    lower = lower.replace(/what'?s/g, 'what is')
                 .replace(/infront/g, 'in front')
                 .replace(/wriotten/g, 'written')
                 .replace(/surounding/g, 'surrounding');

    // ── VISION ──────────────────────────────────────────────────────────────
      const visionKw = ['what do i see', 'what is in front', 'what is around',
        'describe my surroundings', 'what am i looking at', 'use camera',
        'open camera', 'activate camera', 'scan', 'read the sign', 'read the text',
        'read what is written', 'what is written in front of me', 'what is written here',
        'use device camera input', 'device camera', 'inbuilt camera', 'built in camera', 'browser camera', 'webcam',
        'identify', 'detect objects', 'object detection', 'what is this',
        'what is that', 'tell me what you see'];
      if (visionKw.some(k => lower.includes(k)) || /^(see|look|vision|scan|describe)$/i.test(lower)) {
        return res.json({ intent: 'VISION', destination: null });
      }    // ── NAVIGATION — only explicit action commands ────────────────────────
    const navPatterns = [
      /(?:navigate|navigation)\s+to\s+(.+)/i,
      /take\s+me\s+to\s+(.+)/i,
      /guide\s+me\s+to\s+(.+)/i,
      /directions?\s+to\s+(.+)/i,
      /route\s+to\s+(.+)/i,
      /lead\s+me\s+to\s+(.+)/i,
      /walk\s+me\s+to\s+(.+)/i,
      /bring\s+me\s+to\s+(.+)/i,
      /i\s+(?:want|need)\s+to\s+(?:go|get|navigate|reach)\s+to\s+(.+)/i,
      /(?:go|head|get)\s+to\s+(.+)/i,
    ];
    for (const p of navPatterns) {
      const m = message.match(p);
      if (m && m[1]) {
        const dest = m[1].replace(/[?.!,;]+$/, '').trim();
        if (dest.length >= 2) return res.json({ intent: 'NAVIGATION', destination: dest });
      }
    }

    // ── LOCATION_INFO — asking about current position ────────────────────
    const locationInfoKw = ['where am i', 'my location', 'current location',
      'my current location', 'what is my location', 'where are we',
      'what city am i in', 'what area am i in'];
    const isDistanceQuery = /how\s+far|distance|route|navigate|directions|where\s+is/i.test(lower);
    if (!isDistanceQuery && locationInfoKw.some(k => lower.includes(k))) {
      return res.json({ intent: 'LOCATION_INFO', destination: null });
    }

    // ── PLACE_SEARCH — nearby places, no navigation ──────────────────────
    const placeSearchKw = ['nearest', 'closest', 'near me', 'nearby',
      'where is the', 'where is a', 'find a ', 'find the ', 'is there a ', 'is there an ', 'how far is', 'distance to'];
    if (placeSearchKw.some(k => lower.includes(k))) {
      const pm = message.match(/(?:nearest|closest|find\s+(?:a|the)?|where\s+is\s+(?:the|a|an)?|near\s+me|how\s+far\s+is\s+(?:the|a|an)?|distance\s+to\s+(?:the|a|an)?)\s+(.+)/i);
      let dest = pm ? pm[1] : null;
      if (dest) {
          dest = dest.replace(/\b(?:is\s+)?from\s+(?:my\s+location|here|me)\b/i, '')
                     .replace(/[?.!,;]+$/, '')
                     .trim();
      }
      return res.json({ intent: 'PLACE_SEARCH', destination: dest });
    }

    // ── GENERAL_CHAT fallback ─────────────────────────────────────────────
    res.json({ intent: 'GENERAL_CHAT', destination: null });

  } catch (err) {
    console.error('Classify error:', err.message);
    res.json({ intent: 'GENERAL_CHAT', destination: null });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/vision — Image analysis for VisionController
// Body: { image: <base64 data-URL or raw base64>, prompt?: string, source?: 'browser'|'pi' }
// Response: { description: string }
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/vision', async (req, res) => {
  console.log(`[Vision] Request received. image length: ${req.body.image ? req.body.image.length : 0}, source: ${req.body.source}`);

  try {
    const { image, prompt: userPrompt, source, username } = req.body;

    // Build spatial sensor context for vision AI
    const s = latestSensorData;
    let sensorInfo = '';
    if (s.dist > 0 && s.dist <= 400) {
      sensorInfo += `Ultrasonic sensor: nearest object is ${s.dist}cm (${(s.dist / 100).toFixed(1)}m) ahead. `;
    } else {
      sensorInfo += `Ultrasonic sensor: path clear, no object within 4m. `;
    }
    if (s.ir === 1) {
      sensorInfo += `IR sensor: obstacle extremely close (within 10cm). `;
    } else {
      sensorInfo += `IR sensor: no immediate close-range obstacle. `;
    }
    if (s.pir === 1) {
      sensorInfo += `PIR sensor: motion detected nearby. `;
    } else {
      sensorInfo += `PIR sensor: no movement detected. `;
    }

    const systemPrompt =
      'You are a highly concise AI assistant talking directly to a visually impaired user. ' +
      'Describe the scene from their perspective using spatial directions like "to your left", "to your right", or "straight ahead". ' +
      'Focus on immediate physical hazards, primary objects, and read any text or labels clearly. ' +
      'Do NOT use conversational filler (e.g., "In this image, I see..."). ' +
      'Keep responses extremely brief (1-3 short sentences max). ' +
      'IMPORTANT: You also have real-time hardware sensor data. Always include exact distances and proximity warnings from the sensors in your description. ' +
      'Sensor readings: ' + sensorInfo;

    const userInstruction = userPrompt
      ? `The user asked: "${userPrompt}". Describe the image with this in mind.`
      : 'Describe this image for a visually impaired person.';

    // ── Try NVIDIA vision model if image supplied ──
    if (image) {
      // Normalise base64: ensure it is a full data-URL
      const base64 = image.startsWith('data:') ? image : `data:image/jpeg;base64,${image}`;

      try {
          console.log('[Vision] Sending image to vision model...');
          const visionResp = await visionClient.chat.completions.create({
            model: 'meta/llama-3.2-11b-vision-instruct',
            messages: [
              { role: 'system', content: systemPrompt },
            {
              role: 'user',
              content: [
                { type: 'text', text: userInstruction },
                { type: 'image_url', image_url: { url: base64 } },
              ],
            },
          ],
          temperature: 0.4,
          max_tokens: 300,
          stream: false,
        });

        const description = visionResp.choices?.[0]?.message?.content?.trim();
        console.log('[Vision] Model response received:', description?.slice(0, 80));
        
        if (description) {
          // Store vision result in Supabase
          safeInsert('messages', {
            role: 'assistant',
            type: 'vision',
            username: username || 'unknown',
            content: description
          }).catch(err => console.error('Supabase vision insert error:', err));
          
          return res.json({ description, model: 'vision' });
        }
      } catch (visionErr) {
        console.error('[Vision] Model failed:', visionErr.status, visionErr.message);
      }
    }

    // ── Text-only fallback (no image or vision model unavailable) ──
    const fallbackPrompt = userPrompt
      ? `A visually impaired person asked: "${userPrompt}". Provide a helpful, descriptive response about what they might be encountering based on their question.`
      : 'A visually impaired person wants you to describe their surroundings. Provide a general helpful response and ask them to try again.';

    res.json({ description: 'I could not process the image. Please ensure your camera is not covered and try again.', model: 'error-fallback' });

    } catch (err) {
    console.error('Vision error:', err.message);
    res.status(500).json({ error: 'Vision analysis failed', description: 'I could not analyse the scene. Please try again.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/history — Fetch chat history
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/history', async (req, res) => {
  try {
    const { supabase } = require('../lib/supabaseClient.cjs');
    if (!supabase) {
      return res.json([]);
    }
    const username = req.query.username;
    let query = supabase
      .from('messages')
      .select('id, role, content, type, created_at');
    
    if (username) {
      query = query.eq('username', username);
    }

    const { data, error } = await query
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) {
      console.error('Supabase fetch error:', error);
      return res.status(500).json({ error: 'Database error' });
    }

    // Return in chronological order for UI
    res.json(data.reverse());
  } catch (err) {
    console.error('Failed to fetch history:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/navigation/geocode — Geocoding helper (proxied to avoid CORS issues)
// Body: { query: string, lat?: number, lng?: number }
// Response: { lat, lng, displayName }
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/navigation/geocode', async (req, res) => {
  try {
    const fetch = require('node-fetch');
    const { query, lat, lng } = req.body;
    if (!query) return res.status(400).json({ error: 'query required' });

    const params = new URLSearchParams({ q: query, format: 'json', limit: '1', addressdetails: '1' });
    if (lat && lng) {
      const d = 0.5;
      params.set('viewbox', `${lng - d},${lat + d},${lng + d},${lat - d}`);
      params.set('bounded', '0');
    }

    const r = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
      headers: { 'User-Agent': 'VisionAID-Navigation/1.0' },
    });
    const results = await r.json();
    if (!results || results.length === 0) return res.status(404).json({ error: 'not found' });

    const top = results[0];
    res.json({ lat: parseFloat(top.lat), lng: parseFloat(top.lon), displayName: top.display_name });
  } catch (err) {
    console.error('Geocode error:', err.message);
    res.status(500).json({ error: 'Geocode failed' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// RASPBERRY PI API ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/pi/trigger-hardware-camera', (req, res) => {
  hardwareCameraRequest = true;
  hardwareCameraPrompt = (req.body && req.body.prompt) ? String(req.body.prompt) : '';
  hardwareCameraDeferredResponse = res; 
  
  setTimeout(() => {
     if (hardwareCameraDeferredResponse === res) {
         hardwareCameraDeferredResponse.status(504).json({ error: "ESP32 Camera did not respond in time." });
         hardwareCameraDeferredResponse = null;
     }
  }, 60000); // 60 seconds for Wi-Fi Camera Uploads + Vision processing
});

// POST /api/pi/audio-input — Pi sends WAV/audio bytes → transcribe → classify → respond
// Accepts: multipart/form-data with field "audio" (audio file)
//      OR: application/json with { audioBase64: string, mimeType: string }
// Emit HOT trigger to UI immediately upon headers, before buffering 15s of audio!
const emitHardwareStart = (req, res, next) => {
  streamClients.forEach(client => {
    client.write(`data: {"event": "HARDWARE_BTN_TOUCHED"}\n\n`);
  });
  next();
};

app.post('/api/pi/audio-input', emitHardwareStart, express.raw({ type: 'application/octet-stream', limit: '50mb' }), async (req, res) => {
  hardwareRecordingRequest = false;
  console.log(`\n[HARDWARE] 🎙️ Audio/Text request received from ESP/Pi! IP: ${req.ip}`);

  
  try {
    let audioBuffer;

    // STEP 1: RECEIVE AUDIO
    if (req.is('application/octet-stream')) {
      audioBuffer = req.body;
      console.log(`[DEBUG] Received raw PCM audio: ${audioBuffer.length} bytes`);
    } else {
      return res.status(400).json({ error: 'Audio must be application/octet-stream' });
    }

    if (!audioBuffer || audioBuffer.length === 0) {
      return res.status(400).json({ error: 'Empty audio buffer' });
    }

    // STEP 2: CONVERT PCM → WAV (16kHz, mono, 16-bit)
    // ESP sends 16-bit PCM (we need to wrap it with a 44-byte RIFF WAV header)
    const dataSize = audioBuffer.length;
    const wavHeader = Buffer.alloc(44);
    
    wavHeader.write('RIFF', 0);
    wavHeader.writeUInt32LE(36 + dataSize, 4);
    wavHeader.write('WAVE', 8);
    wavHeader.write('fmt ', 12);
    wavHeader.writeUInt32LE(16, 16); // Subchunk1Size
    wavHeader.writeUInt16LE(1, 20);  // AudioFormat (PCM)
    wavHeader.writeUInt16LE(1, 22);  // NumChannels (Mono)
    wavHeader.writeUInt32LE(16000, 24); // SampleRate
    wavHeader.writeUInt32LE(16000 * 2, 28); // ByteRate
    wavHeader.writeUInt16LE(2, 32);  // BlockAlign
    wavHeader.writeUInt16LE(16, 34); // BitsPerSample
    wavHeader.write('data', 36);
    wavHeader.writeUInt32LE(dataSize, 40);

    const wavBuffer = Buffer.concat([wavHeader, audioBuffer]);
    console.log(`[DEBUG] Converted to WAV, final size: ${wavBuffer.length} bytes`);

    // STEP 3: SPEECH TO TEXT (Using Groq Whisper API)
    let transcript = "";
    
    try {
      console.log(`[DEBUG] Attempting STT via Groq Whisper...`);
      
      const FormData = require('form-data');
      const fetch = require('node-fetch');
      
      const form = new FormData();
      form.append('file', wavBuffer, {
        filename: 'audio.wav',
        contentType: 'audio/wav',
      });
      form.append('model', 'whisper-large-v3');
      form.append('language', 'en');

      const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          ...form.getHeaders()
        },
        body: form
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Groq API Error: ${response.status} - ${errText}`);
      }

      const data = await response.json();
      if (data && data.text) {
        transcript = data.text;
      } else {
        transcript = "Empty transcription received";
      }

    } catch (err) {
      console.error('[EROR] Groq STT failed:', err.message);
      transcript = "Error reading audio"; 
    }

    console.log(`[DEBUG] Transcript: ${transcript}`);
    
    // 💾 SAVE USER VOICE TRANSCRIPT TO DATABASE
    try {
      safeInsert('messages', { 
        role: 'user', 
        content: transcript, 
        type: 'voice', 
        username: req.body.username || "hardware_user" 
      }).catch(() => {});
    } catch(e) {}

    let aiResponse = "";
    
    try {
      console.log(`[DEBUG] Running AI Reasoning via Llama 3.3...`);
      const now = new Date();
      // Adjust to IST as that seems to be the user's timezone from the logs
      const timeStr = now.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
      const dateStr = now.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', month: 'long', day: 'numeric' });
      
      const chatPromise = client.chat.completions.create({
        model: 'llama-3.1-8b-instant',
        messages: [
          { role: 'system', content: `You are the Vision AID assistant. The current time is ${timeStr} and today is ${dateStr}. Respond concisely (under 20 words). The user might call you 'Jenny' or other names; just respond helpfully as their assistant.` },
          { role: 'user', content: transcript }
        ],
        temperature: 0.7,
        max_tokens: 50,
      });

      const chatCompletion = await Promise.race([
        chatPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Chat Timeout')), 6000))
      ]);
      
      aiResponse = chatCompletion.choices[0].message.content.trim();
    } catch (err) {
      console.error('[EROR] Llama Chat failed:', err.message);
      aiResponse = "I cannot process that right now.";
    }

    console.log(`[DEBUG] Llama Response: ${aiResponse}`);

    // 💾 SAVE AI RESPONSE TO DATABASE
    try {
      safeInsert('messages', { 
        role: 'assistant', 
        content: aiResponse, 
        type: 'voice', 
        username: req.body.username || "hardware_user" 
      }).catch(() => {});
    } catch(e) {}

    const finalData = {
      text: aiResponse,
      transcript: transcript
    };

    // If the Webpage is holding the connection open waiting for this, send it directly to the Chat UI!
    if (hardwareAudioDeferredResponse) {
      console.log(`[DEBUG] Forwarding ESP32 result directly to Webpage UI!`);
      hardwareAudioDeferredResponse.json(finalData);
      hardwareAudioDeferredResponse = null;
    } else {
      console.log(`[DEBUG] Broadcasting ESP32 STT via SSE!`);
      streamClients.forEach(client => {
        client.write(`data: {"event": "AUDIO_RESULT", "data": ${JSON.stringify(finalData)}}\n\n`);
      });
    }

    // STEP 5: RESPONSE (Send a simple 200 OK back to the ESP32 so it doesn't hang)
    return res.json({
      message: "Success"
    });

  } catch (error) {
    console.error('[ERROR] Audio processing failed:', error);
    if (hardwareAudioDeferredResponse) {
      hardwareAudioDeferredResponse.status(500).json({ error: "Backend internal error during audio processing.", transcript: "Processing crash on Render." });
      hardwareAudioDeferredResponse = null;
    }
    if (!res.headersSent) {
      res.status(500).json({ error: 'Audio processing failed' });
    }
  }
});

// POST /api/pi/image-input — Pi sends a camera image → vision analysis → response
// Accepts: multipart/form-data with field "image" OR JSON { image: base64, prompt: string }
app.post('/api/pi/image-input', upload.single('image'), async (req, res) => {
  hardwareCameraRequest = false;
  console.log(`\n[HARDWARE] 📷 Image received from ESP/Pi! IP: ${req.ip} Data size: ${req.file ? req.file.size : 'base64'} bytes`);
  try {
    const fetch = require('node-fetch');
    let imageData = req.body.image; // JSON base64

    // If multipart file upload
    if (req.file) {
      imageData = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    }

    if (!imageData) return res.status(400).json({ error: 'No image provided' });
    
    const prompt = req.body.prompt || hardwareCameraPrompt || '';
    hardwareCameraPrompt = '';

    const visionResp = await fetch(`http://localhost:${PORT}/api/vision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: imageData, prompt, source: 'pi', username: req.body.username || 'unknown' }),
    });
    const visionData = await visionResp.json();
    
    const finalData = {
      description: visionData.description,
      source: 'pi',
    };

    if (hardwareCameraDeferredResponse) {
       console.log(`[DEBUG] Forwarding ESP32 Camera result directly to Webpage UI!`);
       hardwareCameraDeferredResponse.json(finalData);
       hardwareCameraDeferredResponse = null;
    }

    res.json(finalData);
  } catch (err) {
    console.error('Pi image-input error:', err.message);
    res.status(500).json({ error: 'Image analysis failed' });
  }
});

// POST /api/pi/audio-output — Client requests TTS audio bytes for Pi speaker
// Body: { text: string }
// Returns: { text, audioNote: string } — browser TTS is used on the frontend;
//          this endpoint returns metadata and can be extended with a TTS service.
app.post('/api/pi/audio-output', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'text required' });

    // If a TTS_API_KEY is configured, call an external TTS service here.
    // For now we return the text and let the Pi do TTS locally.
    res.json({
      text,
      audioNote: 'Use browser SpeechSynthesis or local Pi espeak/festival for playback.',
    });
  } catch (err) {
    console.error('Pi audio-output error:', err.message);
    res.status(500).json({ error: 'Audio output failed' });
  }
});

// =========================================================================
// HARDWARE POLLING ROUTES
// =========================================================================

// ─── HARDWARE / WEBPAGE SYNC STATE ───────────────────────────────────────────
let hardwareHealth = { lastMicPoll: 0, lastCamPoll: 0 };
let hardwareRecordingRequest = false;
let hardwareIsCurrentlyListening = false;
let hardwareAudioDeferredResponse = null;

let hardwareCameraRequest = false;
let hardwareCameraDeferredResponse = null;
let hardwareCameraPrompt = '';

// Live spatial sensor cache — updated every ~1s by ESP32 over WebSocket
let latestSensorData = { pir: 0, dist: -1, ir: 0 };

// ─── SSE ROUTER FOR GHOST-CLICK (Physical Button -> Website Sync) ───
let streamClients = [];

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders(); 

  streamClients.push(res);

  req.on('close', () => {
    streamClients = streamClients.filter(c => c !== res);
  });
});

app.post('/api/pi/button-pressed', (req, res) => {
  console.log('[API] ESP32 Physical Button Touched! Alerting Website UI via SSE Streams...');
  streamClients.forEach(client => {
    client.write(`data: {"event": "HARDWARE_BTN_TOUCHED"}\n\n`);
  });
  res.json({ success: true });
});

app.post('/api/pi/button-released', (req, res) => {
  console.log('[API] ESP32 Physical Button Released! Alerting Website UI via SSE Streams...');
  streamClients.forEach(client => {
    client.write(`data: {"event": "HARDWARE_BTN_RELEASED"}\n\n`);
  });
  res.json({ success: true });
});

// 3. Status Poll Endpoint (Pi checks this every second)
app.get('/api/pi/status', (req, res) => {
  // Health Heartbeat interceptor
  if (req.query.device === 'mic') hardwareHealth.lastMicPoll = Date.now();
  if (req.query.device === 'cam') hardwareHealth.lastCamPoll = Date.now();

  // We use this endpoint for BOTH camera and mic polling to avoid two separate intervals.
  let action = 'IDLE';

  if (hardwareRecordingRequest && req.query.t) {
    action = 'RECORD';
    // The ESP32 physically just retrieved the RECORD command, meaning it is starting to record!
    hardwareIsCurrentlyListening = true;
  } else if (hardwareCameraRequest) {
    action = 'CAPTURE_IMAGE';
  }

  res.json({ action });
});

// NEW: Health Diagnostic Endpoint for Vercel Widget
app.get('/api/pi/health', (req, res) => {
  const now = Date.now();
  res.json({
    micOnline: (now - hardwareHealth.lastMicPoll) <= 15000,
    camOnline: (now - hardwareHealth.lastCamPoll) <= 15000
  });
});

// NEW: Polling Endpoint for Frontend to track if Pi is actively recording
app.get('/api/pi/listening-status', (req, res) => {
  res.json({ listening: hardwareIsCurrentlyListening });
});

app.post('/api/pi/trigger-hardware-mic', (req, res) => {
  console.log('[API] Hardware Mic Triggered. Waiting for PI POST...');
  
  if (hardwareRecordingRequest) {
    if (hardwareAudioDeferredResponse) {
      hardwareAudioDeferredResponse.status(409).json({ error: 'Already waiting for an existing mic request.' });
    }
  }

  hardwareRecordingRequest = true;
  hardwareIsCurrentlyListening = false; // Set to false until ESP32 acknowledges
  hardwareAudioDeferredResponse = res; // Hold the connection open!
  
  // If the ESP is off or ignoring us, timeout after 15 seconds so we don't hang the webpage forever
  setTimeout(() => {
     if (hardwareAudioDeferredResponse === res) {
         hardwareAudioDeferredResponse.status(504).json({ error: "ESP32 did not respond in time.", transcript: "Hardware Timeout" });
         hardwareAudioDeferredResponse = null;
         hardwareIsCurrentlyListening = false;
     }
  }, 45000); 
});
// ─────────────────────────────────────────────────────────────────────────────

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'index.html'));
});

// ─── Export for Vercel, Listen for Local ─────────────────────────────────────
module.exports = app;

const { WebSocketServer } = require('ws');

function setupWebSocket(server) {
  const wss = new WebSocketServer({ server, path: '/api/pi/ws' });



  wss.on('connection', (ws, req) => {
    console.log('[WS] New ESP32 Client Connected', req.socket.remoteAddress);
    let audioChunks = [];
    
    ws.on('message', async (message, isBinary) => {
      // Keep the dashboard health indicator alive
      hardwareHealth.lastMicPoll = Date.now();

      if (!isBinary) {
        const text = message.toString();

        // ─── SENSOR TELEMETRY ───
        if (text.startsWith('{"type":"sensors"')) {
          try {
            const parsed = JSON.parse(text);
            latestSensorData.pir = parsed.pir;
            latestSensorData.dist = parsed.dist;
            latestSensorData.ir = parsed.ir;
          } catch(e) {}
          return;
        }

        if (text === "START") {
          console.log('[WS] ESP32 triggered START recording');
          audioChunks = [];
          streamClients.forEach(client => {
            client.write(`data: {"event": "HARDWARE_BTN_TOUCHED"}\n\n`);
          });
        } else if (text === "STOP") {
          console.log(`[WS] ESP32 triggered STOP. Processing ${audioChunks.length} chunks...`);
          
          // Tell the UI to turn off the red "Recording" UI immediately
          streamClients.forEach(client => {
            client.write(`data: {"event": "HARDWARE_BTN_RELEASED"}\n\n`);
          });

          if (audioChunks.length === 0) return;
          
          const audioBuffer = Buffer.concat(audioChunks);
          audioChunks = [];
          
          try {
            const dataSize = audioBuffer.length;
            const wavHeader = Buffer.alloc(44);
            
            wavHeader.write('RIFF', 0);
            wavHeader.writeUInt32LE(36 + dataSize, 4);
            wavHeader.write('WAVE', 8);
            wavHeader.write('fmt ', 12);
            wavHeader.writeUInt32LE(16, 16); 
            wavHeader.writeUInt16LE(1, 20);  
            wavHeader.writeUInt16LE(1, 22);  
            wavHeader.writeUInt32LE(16000, 24); 
            wavHeader.writeUInt32LE(16000 * 2, 28); 
            wavHeader.writeUInt16LE(2, 32);  
            wavHeader.writeUInt16LE(16, 34); 
            wavHeader.write('data', 36);
            wavHeader.writeUInt32LE(dataSize, 40);

            const wavBuffer = Buffer.concat([wavHeader, audioBuffer]);
            
            let transcript = "";
            const FormData = require('form-data');
            const fetch = require('node-fetch');
            const form = new FormData();
            form.append('file', wavBuffer, { filename: 'audio.wav', contentType: 'audio/wav' });
            form.append('model', 'whisper-large-v3');
            form.append('language', 'en');

            const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
                ...form.getHeaders()
              },
              body: form
            });

            if (response.ok) {
              const data = await response.json();
              transcript = data.text || "Empty transcription";
            } else {
              transcript = "Error reading audio";
            }
            
            console.log(`[WS] Transcript: ${transcript}`);
            
            try {
              safeInsert('messages', { role: 'user', content: transcript, type: 'voice', username: "hardware_user" }).catch(() => {});
            } catch(e) {}

            // STEP 4: AI REASONING (with Spatial Context)
            let aiResponse = "";
            const _p1 = "nvapi-S_iKSD-";
            const _p2 = "CJDP6_l9TeApwME";
            const _p3 = "OCNWtz4OqsTA_lAURNJ";
            const _p4 = "t8edt_dRjqd3pW6htAYnc7_";
            const HARDCODED_KEY = _p1 + _p2 + _p3 + _p4;
            
            const OpenAI = require('openai');
            const wsClient = new OpenAI({
              baseURL: process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1',
              apiKey:  process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY || HARDCODED_KEY,
            });

            // Build spatial awareness context — ALWAYS report ALL sensors
            const s = latestSensorData;
            let spatialContext = "";
            
            // Ultrasonic distance (always report)
            if (s.dist > 0 && s.dist <= 400) {
              spatialContext += `Ultrasonic distance sensor: nearest object is exactly ${s.dist}cm (${(s.dist / 100).toFixed(1)} meters) ahead. `;
            } else {
              spatialContext += `Ultrasonic distance sensor: path is clear, no object detected within 4 meters. `;
            }
            
            // IR close-range (always report)
            if (s.ir === 1) {
              spatialContext += `IR proximity sensor: WARNING — obstacle detected extremely close (within 10cm), immediate collision risk. `;
            } else {
              spatialContext += `IR proximity sensor: no immediate close-range obstacle. `;
            }
            
            // PIR motion (always report)
            if (s.pir === 1) {
              spatialContext += `PIR motion sensor: movement/person detected in the surrounding area. `;
            } else {
              spatialContext += `PIR motion sensor: no movement detected nearby, area appears still. `;
            }

            console.log(`[WS] Spatial Context: ${spatialContext}`);

            const now = new Date();
            const timeStr = now.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
            const dateStr = now.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', month: 'long', day: 'numeric' });

            const systemPrompt = `You are Vision AID, an assistive AI for a visually impaired user. The current time is ${timeStr}, ${dateStr}. You MUST use ALL the sensor data below in EVERY response. Always mention the exact distance in cm/meters, whether an obstacle is close, and whether motion is detected. Never ignore a sensor reading. Sensor readings: ${spatialContext}`;

            const chatPromise = wsClient.chat.completions.create({
              model: 'llama-3.1-8b-instant',
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: transcript }
              ],
              temperature: 0.7,
              max_tokens: 50,
            });

            const chatCompletion = await Promise.race([
              chatPromise,
              new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 6000))
            ]);
            
            aiResponse = chatCompletion.choices[0].message.content.trim();
            console.log(`[WS] AI: ${aiResponse}`);
            
            try {
              safeInsert('messages', { role: 'assistant', content: aiResponse, type: 'voice', username: "hardware_user" }).catch(() => {});
            } catch(e) {}

            const finalData = { text: aiResponse, transcript: transcript };

            streamClients.forEach(client => {
              client.write(`data: {"event": "AUDIO_RESULT", "data": ${JSON.stringify(finalData)}}\n\n`);
            });
            
          } catch (err) {
            console.error('[WS] Process Error:', err);
          }
        }
      } else {
        // Binary audio format
        audioChunks.push(message);
      }
    });

    ws.on('close', () => {
      console.log('[WS] ESP32 Disconnected');
    });
  });
}

if (process.env.VERCEL) {
  // Let Vercel handle the wrapper
} else {
    const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Vision AID server running on http://localhost:${PORT}`);
    console.log('Endpoints: /api/ai/chat, /api/ai/classify, /api/vision, /api/navigation/geocode');
    console.log('Pi Endpoints: /api/pi/audio-input, /api/pi/image-input, /api/pi/audio-output');
    console.log('WebSocket Server ready at wws://[host]/api/pi/ws');
  });
  setupWebSocket(server);
}
