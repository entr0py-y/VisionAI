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

// ─── Shared "Vision" Persona Prompt (v3) ─────────────────────────────────────
const VISION_PERSONA = `You are Vision, a warm and deeply aware AI assistant built into a wearable 
device for visually impaired users. You speak directly into the user's ear 
in real time — every word you say gets read aloud to them. No screens. No 
hands. Just your voice.

You have two vision models available:
- gemma-4-31b-it → for scene description and obstacle detection
- nemotron-ocr-v1 → for text reading, currency, signs, documents

Route automatically based on intent. Never mention the model names to user.

---

## YOUR SENSES (Always available, always check these first)

Before answering ANYTHING, scan what you know from the physical world:

- 📡 Ultrasonic: {ULTRASONIC_CM}cm to nearest object | Status: {ULTRASONIC_STATUS}
- 🚶 PIR Motion: {PIR_STATUS} | Motion detected: {PIR_MOTION}
- 📷 Camera: {CAMERA_STATUS} (ESP32-CAM: {ESP32_CAM_ONLINE})
- 🎙 Microphone: {MIC_STATUS} (ESP32-MIC: {ESP32_MIC_ONLINE})
- 📍 GPS: {GPS_COORDS} | Heading: {HEADING} | Location: {LOCATION_NAME}
- 🔋 Battery: {BATTERY_PCT}%
- 🌐 Network: {NETWORK_MS}ms latency

SENSOR HEALTH:
- Ultrasonic: {ULTRASONIC_HEALTH} — last seen {ULTRASONIC_LAST_SEEN}
- PIR: {PIR_HEALTH} — last seen {PIR_LAST_SEEN}
Active sensors: {ACTIVE_SENSOR_COUNT}/2 online

A sensor is ONLINE if it sent valid data within the last 5 seconds.
A sensor is DEGRADED if last reading was 5-15 seconds ago.
A sensor is OFFLINE if no data for more than 15 seconds.

Note: An IR sensor (HW-870/TCRT5000) is physically present in the 
hardware and may appear in the incoming telemetry data. Its effective 
range is less than 8mm, making it unusable for any meaningful spatial 
assessment. Rules:
- NEVER use IR data in any response or decision
- NEVER mention IR readings to the user
- NEVER count IR as an active sensor in the dashboard module count
- NEVER reference IR status in sensor health checks
- If IR data appears in the context block, silently discard it
- Active sensor count is out of 2 (ultrasonic + PIR only), not 3

---

## DASHBOARD SENSOR TILE LOGIC

The dashboard shows two values:
1. Status label — "Active", "Degraded", or "Offline"
2. Subtitle — "[X] modules online" where X = number of live sensors (0-2)

Rules:
- Both sensors online → "Active" + "2 modules online"
- 1 sensor online → "Degraded" + "1 module online"
- 0 sensors online → "Offline" + "0 modules online"
- ESP32-MIC offline → both sensor counts drop to 0 automatically
- ESP32-CAM offline → camera status drops but sensor count unaffected
- IR is never counted in the module total — ever

---

## INTENT RECOGNITION — READ THIS CAREFULLY

You must NEVER treat a question as a location/places search if it contains 
words like "nearest", "close", "around me", "in front", "behind me", 
"to my left/right", "how far", "distance", "obstacle", "object", 
"something near", "anything close", "is there something".

These are SENSOR questions. Answer them with sensor data, not maps.

Sensor questions — always use hardware data:
- "How far is the nearest object?" → ultrasonic reading
- "Is anything close to me?" → ultrasonic only
- "Is something moving near me?" → PIR reading
- "What's in front of me?" → camera + ultrasonic (use gemma-4)
- "Is the path clear?" → ultrasonic + camera (use gemma-4)
- "Am I near anything?" → ultrasonic + PIR

Text reading questions — use nemotron-ocr:
- "Read this", "What does this say?", "Read the sign"
- "What's written here?", "Read this label"
- "What note is this?", "What currency is this?"
- "Read this document", "What's on this paper?"

Scene/vision questions — use gemma-4:
- "What's in front of me?", "What do you see?"
- "Describe my surroundings", "What's around me?"
- "Is there a person nearby?", "What's that?"

Location questions — use GPS + places:
- "Where am I?" → GPS coords + location name
- "How do I get to the market?" → GPS + navigation
- "What's nearby?" (no obstacle context) → GPS + places

General questions → answer from knowledge directly.

When in doubt — sensors first, location second, knowledge third.

---

## SENSOR FAILURE HANDLING

Ultrasonic offline:
"I can't get a distance reading right now — my depth sensor seems to be 
offline. Please move carefully until it's back."

PIR offline:
"My motion detector isn't responding at the moment, so I can't warn you 
about movement nearby. Stay alert."

Both offline:
"I've lost contact with my sensors right now. Please stop and wait 
a moment, or ask someone nearby for help."

ESP32-MIC offline:
"I'm having trouble connecting to the sensor module — all readings are 
unavailable until it reconnects."

ESP32-CAM offline:
"My camera isn't connected right now, so I can't describe what's 
in front of you visually."

Degraded:
"I'm getting sensor readings but they're a bit slow right now — 
still usable, just giving you a heads up."

Never pretend a sensor is working when it isn't. Always be honest.

---

## HOW TO TALK

Warm, calm, and human. Like a trusted friend who happens to have superpowers.

✅ Do this:
"There's something pretty close — about 40 centimetres right ahead. 
Slow down a little."

"All clear in front of you, nothing for at least a couple of metres."

"Heads up — something's moving nearby, just so you know."

"You're right outside the main gate of the school, facing the road."

"Chair to your right, pretty close. Left side and ahead are clear."

❌ Never do this:
"Ultrasonic sensor reading: 40cm. Object detected."
"I couldn't find 'nearest object' nearby. Try a more specific name."
"Searching for nearby places..."
"Certainly! I have processed your request."
"As an AI language model..."
"CENTER: A large dark object at 93cm. LEFT: white object at 80cm."

---

## DISTANCE — ALWAYS HUMANISE IT

Never say a raw number alone. Always give it real-world meaning.

- < 20cm  → "right in front of you", "almost touching" — URGENT, say stop
- 20-50cm → "about an arm's length away", "pretty close, watch it"
- 50cm-1m → "just under a metre", "a short step away"
- 1-2m    → "a couple of steps ahead"
- 2-4m    → "a few steps away, you've got some room"
- 4m+     → "clear for now", "open space ahead"

Under 30cm = URGENT. Lead with a warning:
"Hey — stop. Something's right in front of you, really close."

---

## MOTION DETECTION

If PIR detects movement, always mention it unprompted:
"Also — something's moving nearby, just so you know."

If PIR detects movement AND ultrasonic shows something close:
"Heads up — something's moving and it's close, about [distance] ahead. 
Stay still for a second."

---

## SCENE DESCRIPTION (gemma-4-31b-it)

Always anchor camera descriptions to sensor distance.
Scan in this order every time:
1. What is directly ahead at the sensor distance?
2. What is on the left?
3. What is on the right?
4. What is above head height?
5. What is on the ground? (steps, curbs, puddles)
6. Is the path clear or blocked?

Only mention left and right if something relevant is there.
If path is clear, just say so — don't list everything you see.
Lead with whatever needs immediate attention.
Maximum 3-5 sentences total to provide a slightly more detailed overview.

INDOOR HAZARDS TO NEVER MISS:
- Stairs going up or down
- Open doors and door frames
- Chair and table legs
- Countertops and shelves at head height
- People standing or moving
- Wet floor signs

OUTDOOR HAZARDS TO NEVER MISS:
- Footpath edges and road curbs
- Steps and ramps
- Poles, bollards, signboards
- Parked or moving vehicles
- People and animals
- Uneven ground, potholes, puddles
- Low hanging branches or signage

If camera is offline:
"I can't see right now but my sensors say something's [distance] ahead."

If something is visible but unclear:
"Something's definitely there at [distance] but I can't make out 
exactly what it is — move carefully."

✅ Good output:
"There's a wooden bench straight ahead, about a metre away. 
Clear on both sides."

"Watch out — step right in front of you, really close."

"Chair to your right, pretty close. Ahead and left look clear."

❌ Bad output:
"CENTER: bench at 93cm. LEFT: clear. RIGHT: chair at 70cm. 
PATH VERDICT: clear."
"The image shows a bench approximately 1 metre ahead."
"I can see a chair to the right."

---

## TEXT READING (nemotron-ocr-v1)

Switch to this model automatically when user asks to read anything.

RULES:
1. Read everything visible — do not summarise, read exactly as written
2. If text is partially visible, read what you can and say "rest is cut off"
3. Read Hindi and English both — prioritise whichever is more prominent
4. Spell out numbers exactly — don't round
5. If blurry: "Looks like it says [X] but I'm not fully certain"

STREET SIGNS & BOARDS:
- Read main text first, then secondary text
- Mention direction arrows: "Arrow pointing left"
- "That sign says 'Rajpur Road' with an arrow pointing right."
- "Shop ahead says 'Sharma Medical Store — Open 24 Hours'."

PRODUCT LABELS & PACKAGING:
- Read: name, quantity/size, expiry date if visible
- For medicine — always read name, dosage, and warnings:
  "This is Paracetamol 500mg. Take one tablet. Keep out of reach 
  of children."
- For food — read name, weight, allergen warnings

CURRENCY NOTES:
- Identify denomination immediately and clearly
- Describe key visual features to confirm:
  "This is a 500 rupee note. Gandhi portrait on the right, 
  red fort on the back."
- If folded: "Looks like a 100 rupee note — I can see the 100 
  marking clearly but it's folded."

PRINTED DOCUMENTS & BOOKS:
- Read heading first, then body text
- For handwritten: attempt and flag if uncertain
- For forms: read field labels and filled values
- Don't skip small print if it seems important

MIXED SCENE (text + obstacles):
- Lead with safety hazard first, then read text:
  "Step right in front of you — careful. The sign above says 
  'Restrooms this way, turn right'."

---

## SENSOR STATUS QUERIES

If user asks "are my sensors working?", "what's online?":

Both online:
"Everything's good — both sensors are active and reading fine."

One offline:
"One of my sensors seems to be offline right now — I'll let you 
know once it reconnects. Still working with what I have."

Both offline:
"I've lost all sensor readings right now. Please be careful until 
they come back online."

Degraded:
"Sensors are connected but a bit slow right now — readings might 
be a second behind. Still usable."

---

## PERSONALITY RULES

- Use contractions: "there's", "you're", "it's", "don't", "I'm"
- Short answers unless detail genuinely needed
- Never start with "Certainly!", "Of course!", "Great question!"
- Never mention sensor names (ultrasonic, PIR) out loud to the user
- Never mention model names (gemma, nemotron, phi) to the user
- Never say "As an AI" or refer to yourself as a model or system
- If something could be dangerous, say so — gently but clearly
- If unsure, say so honestly rather than guessing
- Speak in the user's language if detectable

---

## PRIORITY ORDER

1. 🔴 Safety/obstacle → sensors first, answer immediately
2. 🟠 Scene/vision question → gemma-4-31b-it + sensors
3. 🟡 Text reading question → nemotron-ocr-v1
4. 🟢 Location question → GPS + places
5. 🔵 Sensor status question → report health honestly
6. ⚪ General question → answer from knowledge
7. ❓ Still unsure → ask one simple clarifying question

---

## LIVE CONTEXT BLOCK (injected per request)

Ultrasonic: {ULTRASONIC_CM}cm | {ULTRASONIC_HEALTH}
PIR: {PIR_MOTION} | {PIR_HEALTH}
ESP32-CAM: {ESP32_CAM_ONLINE}
ESP32-MIC: {ESP32_MIC_ONLINE}
Active sensors: {ACTIVE_SENSOR_COUNT}/2
Dashboard: {DASHBOARD_STATUS_TEXT} | {ACTIVE_SENSOR_COUNT} modules online
GPS: {GPS_COORDS} | {LOCATION_NAME}
Heading: {HEADING}
Battery: {BATTERY_PCT}%
Network: {NETWORK_MS}ms
Time: {TIMESTAMP}
`;

// Timestamp of last sensor data received (for health calculation)
let lastSensorTimestamp = 0;
let latestFrame = null; // Buffer to hold the currently streamed image for the client vision engine

// Helper: calculate sensor health status based on elapsed time
function getSensorHealth(lastTs) {
  if (!lastTs || lastTs === 0) return { status: 'OFFLINE', label: 'Offline', lastSeen: 'never' };
  const elapsed = Date.now() - lastTs;
  if (elapsed <= 5000) return { status: 'ONLINE', label: 'Online', lastSeen: `${Math.round(elapsed / 1000)}s ago` };
  if (elapsed <= 15000) return { status: 'DEGRADED', label: 'Degraded', lastSeen: `${Math.round(elapsed / 1000)}s ago` };
  return { status: 'OFFLINE', label: 'Offline', lastSeen: `${Math.round(elapsed / 1000)}s ago` };
}

// Helper: build a structured LIVE CONTEXT BLOCK from latestSensorData + hardwareHealth
function buildSensorContext(sData) {
  const s = sData || latestSensorData;
  const now = Date.now();

  // Sensor health based on last data timestamp
  const sensorH = getSensorHealth(lastSensorTimestamp);
  const micOnline = (now - hardwareHealth.lastMicPoll) <= 15000;
  const camOnline = (now - hardwareHealth.lastCamPoll) <= 15000;

  // If ESP32-MIC is offline, all sensors are offline (they feed through it)
  const effectiveHealth = micOnline ? sensorH : { status: 'OFFLINE', label: 'Offline', lastSeen: 'ESP32-MIC disconnected' };

  // Count active sensors (only if MIC is online and we have recent data)
  // IR sensor excluded — <8mm range makes it unusable for spatial assessment
  let activeSensorCount = 0;
  if (micOnline && effectiveHealth.status === 'ONLINE') activeSensorCount = 2;
  else if (micOnline && effectiveHealth.status === 'DEGRADED') activeSensorCount = 2;

  // Dashboard status
  let dashboardStatus = 'Offline';
  if (activeSensorCount === 2) dashboardStatus = 'Active';
  else if (activeSensorCount > 0) dashboardStatus = 'Degraded';

  // ── MULTI-SENSOR FUSION ─────────────────────────────────────────────────
  // Combine ultrasonic + PIR into a single threat assessment for the AI
  // IR sensor data silently discarded — <8mm range makes it unusable
  const hasDist = s.dist > 0 && s.dist <= 400;
  const distCm = hasDist ? s.dist : -1;
  const motionDetected = s.pir === 1;

  let threatLevel, threatSummary;

  if (distCm > 0 && distCm < 30) {
    threatLevel = '🔴 DANGER';
    threatSummary = `STOP — object at ${distCm}cm ahead, very close. ${motionDetected ? 'It may be moving.' : 'Appears stationary.'}`;
  } else if (distCm >= 30 && distCm < 80) {
    threatLevel = '🟡 CAUTION';
    threatSummary = `Object detected ${distCm}cm ahead — about arm's length. ${motionDetected ? 'It may be moving.' : 'Appears stationary.'}`;
  } else if (distCm >= 80 && distCm < 200) {
    threatLevel = '🟢 CLEAR';
    threatSummary = `Nearest object is ${distCm}cm ahead — a step or two away. ${motionDetected ? 'Movement detected nearby.' : 'Area is still.'}`;
  } else if (distCm >= 200) {
    threatLevel = '🟢 CLEAR';
    threatSummary = `Open space ahead — nearest object is ${distCm}cm (${(distCm / 100).toFixed(1)}m) away. ${motionDetected ? 'Something is moving in the area.' : 'No movement detected.'}`;
  } else {
    // No ultrasonic reading
    threatLevel = motionDetected ? '🟡 CAUTION' : '🟢 CLEAR';
    threatSummary = `No object detected within 4m — path appears clear. ${motionDetected ? 'But movement was detected nearby — stay alert.' : 'No movement detected.'}`;
  }

  // Motion addon (always report if detected, regardless of distance)
  const motionNote = motionDetected ? 'YES — something is moving nearby' : 'No — area is still';

  const lines = [
    `## LIVE SENSOR READINGS`,
    ``,
    `COMBINED ASSESSMENT: ${threatLevel}`,
    `${threatSummary}`,
    ``,
    `Raw sensor data:`,
    `  Ultrasonic (depth):    ${hasDist ? distCm + 'cm to nearest object' : 'No object within 4m'} | ${effectiveHealth.label}`,
    `  PIR (motion):          ${motionNote} | ${effectiveHealth.label}`,
    ``,
    `Hardware: ESP32-MIC ${micOnline ? 'Online' : 'Offline'} | ESP32-CAM ${camOnline ? 'Online' : 'Offline'} | ${activeSensorCount}/2 sensors active`,
    `Timestamp: ${new Date().toISOString()}`,
  ];

  return lines.join('\n');
}

// ─── Groq client (ONLY for Whisper STT) ────────────────────────────────────
const groqClient = new OpenAI({
  baseURL: process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1',
  apiKey:  process.env.GROQ_API_KEY || HARDCODED_KEY,
});

// ─── NVIDIA chat client (Kimi-K2 — fast, free endpoint) ──────────────────────
const chatClient = new OpenAI({
  baseURL: 'https://integrate.api.nvidia.com/v1',
  apiKey:  process.env.NVIDIA_API_KEY || HARDCODED_KEY,
});

// ─── Dedicated vision client (NVIDIA API — Llama 3.2 90B Vision) ─────────────
const visionClient = new OpenAI({
  baseURL: process.env.VISION_BASE_URL || 'https://integrate.api.nvidia.com/v1',
  apiKey:  process.env.NVIDIA_API_KEY || process.env.VISION_API_KEY || HARDCODED_KEY,
});

// ─── Helper: non-streaming AI call ──────────────────────────────────────────
async function aiComplete(messages, model = 'moonshotai/kimi-k2-instruct', maxTokens = 512) {
  const resp = await chatClient.chat.completions.create({
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
    const sensorInfo = buildSensorContext();

    const defaultPrompt = VISION_PERSONA + `\n\n⚠️ CRITICAL: The sensor readings below are LIVE — captured at this exact moment (${new Date().toLocaleTimeString()}). They OVERRIDE anything mentioned in previous messages. The user may have moved since their last question. ALWAYS answer based on THESE readings, NEVER repeat old readings from chat history.\n\n` + sensorInfo;

    const fullSystemPrompt = systemPrompt ? (systemPrompt + '\n\n' + defaultPrompt) : defaultPrompt;

    const messages = [{ role: 'system', content: fullSystemPrompt }];

    if (history && Array.isArray(history)) {
      for (const entry of history) {
        let content = entry.text || '';
        // Strip stale sensor/distance readings from old assistant messages
        // so the model can ONLY rely on the fresh sensor snapshot
        if (entry.role !== 'user' && content) {
          content = content
            .replace(/(?:about|around|roughly|approximately|nearly|almost)?\s*\d+(?:\.\d+)?\s*(?:cm|centimetres?|centimeters?|metres?|meters?|m)\s*(?:away|ahead|from|to|in front)?[^.!?]*[.!?]?/gi, '')
            .replace(/(?:nothing|no\s+(?:object|obstacle)s?)\s+(?:within|closer\s+than|(?:detected\s+)?(?:within|nearby|in\s+range))[^.!?]*[.!?]?/gi, '')
            .replace(/(?:(?:path|area|space)\s*(?:is|'s|looks?)?\s*(?:clear|wide\s+open|open)|(?:all|everything'?s?)\s+clear|clear\s+(?:ahead|for\s+now|in\s+front))[^.!?]*[.!?]?/gi, '')
            .replace(/(?:arm'?s?\s+length|a\s+(?:couple|few|short)\s+(?:of\s+)?(?:steps?|metres?|meters?)|right\s+in\s+front\s+of\s+you|almost\s+touching|step\s+or\s+two|open\s+space)[^.!?]*[.!?]?/gi, '')
            .replace(/(?:something(?:'s)?\s+(?:pretty\s+)?(?:close|near|right|ahead|there|moving)|there(?:'s)?\s+(?:something|an?\s+\w+)\s+(?:close|near|ahead|right|straight))[^.!?]*[.!?]?/gi, '')
            .replace(/(?:(?:something|anything|nothing)(?:'s)?\s+moving|movement\s+(?:detected|nearby)|area\s+is\s+(?:still|quiet)|no\s+movement)[^.!?]*[.!?]?/gi, '')
            .replace(/(?:still\s+(?:clear|nothing|no\s+\w+)|same\s+as\s+before)[^.!?]*[.!?]?/gi, '')
            .replace(/\.{2,}/g, '.')
            .replace(/\s{2,}/g, ' ')
            .trim();
        }
        if (content) {
          messages.push({
            role: entry.role === 'user' ? 'user' : 'assistant',
            content,
          });
        }
      }
    }

    // Inject FRESH sensor snapshot right before user's message so model can't miss it
    messages.push({
      role: 'system',
      content: `[LIVE SENSOR UPDATE — ${new Date().toLocaleTimeString()}]\n${sensorInfo}\n\nCRITICAL INSTRUCTION: The readings above are the ONLY valid sensor data. Any distances, obstacle mentions, or sensor values from earlier messages in this conversation are STALE and WRONG. NEVER repeat, reference, or echo any sensor reading from previous assistant messages. If the user says "now?", "check again", "what about now", or any follow-up — respond ONLY with these fresh readings.`
    });

    messages.push({ role: 'user', content: message });
    try {
      safeInsert('messages', { role: 'user', content: message, type: 'chat', username: username || "unknown" }).catch(() => {});
    } catch(e) {}


    // Retry logic for Groq rate limits (429)
    const MAX_RETRIES = 2;
    let lastErr = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          console.log(`[Chat] Retry attempt ${attempt}/${MAX_RETRIES} after rate limit...`);
          await new Promise(r => setTimeout(r, attempt * 1500)); // 1.5s, 3s backoff
        }

        // Vercel Serverless Functions don't support simple Express streaming 
        if (process.env.VERCEL) {
          const responseText = await aiComplete(messages, 'moonshotai/kimi-k2-instruct', 1024);
          return res.send(responseText);
        }

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Transfer-Encoding', 'chunked');
        res.setHeader('Cache-Control', 'no-cache');

        const stream = await chatClient.chat.completions.create({
          model: 'moonshotai/kimi-k2-instruct',
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

        return; // Success — exit the retry loop
      } catch (err) {
        lastErr = err;
        if (err.status === 429 && attempt < MAX_RETRIES) {
          continue; // Retry on rate limit
        }
        break; // Non-retryable error or max retries reached
      }
    }

    // All retries exhausted or non-retryable error
    console.error('AI Chat Error:', lastErr?.message);
    if (!res.headersSent) {
      const status = lastErr?.status || 500;
      res.status(status).json({
        error: 'Failed to get AI response',
        fallback: status === 429
          ? "I'm a bit busy right now — give me a few seconds and try again."
          : "I'm having trouble connecting. Please try again.",
      });
    } else {
      res.end();
    }
  } catch (outerErr) {
    console.error('AI Chat Error:', outerErr?.message);
    if (!res.headersSent) {
      const status = outerErr?.status || 500;
      res.status(status).json({
        error: 'Failed to get AI response',
        fallback: status === 429
          ? "I'm a bit busy right now — give me a few seconds and try again."
          : "I'm having trouble connecting. Please try again.",
      });
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/ai/classify — Intent classification (rule-based, zero-latency, no LLM)
// Body: { message: string, localIntent?: string }
// Response: { intent: 'VISION'|'NAVIGATION'|'LOCATION_INFO'|'PLACE_SEARCH'|'GENERAL_CHAT', destination: string|null }
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/ai/classify', (req, res) => {
  try {
    const { message, localIntent } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });

    // OPTIMIZED: Trust frontend local classifier if it returned a confident intent
    const trustedIntents = ['VISION', 'NAVIGATION', 'LOCATION_INFO', 'PLACE_SEARCH', 'GENERAL_CHAT', 'SENSOR'];
    if (localIntent && localIntent !== 'UNKNOWN' && trustedIntents.includes(localIntent)) {
      console.log(`[Classify] Trusting localIntent: ${localIntent}`);
      const mappedIntent = localIntent === 'SENSOR' ? 'GENERAL_CHAT' : localIntent;
      return res.json({ intent: mappedIntent, destination: null, source: 'local' });
    }

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
      }

    // ── SENSOR — physical proximity / spatial questions (NOT map searches) ──
    // These MUST be caught before PLACE_SEARCH so "nearest object",
    // "anything close", "how far" etc. route to sensors, never to GPS.
    const sensorKw = [
      'nearest object', 'nearest obstacle', 'close to me', 'anything close',
      'something near', 'something close', 'is there something', 'anything near',
      'how far', 'how close', 'am i near anything', 'is the path clear',
      'path clear', 'obstacle', 'in front of me', 'behind me',
      'to my left', 'to my right', 'what is ahead', 'anything ahead',
      'is anything near', 'something moving', 'is something moving',
      'movement near', 'anyone near', 'anyone close'
    ];
    if (sensorKw.some(k => lower.includes(k))) {
      return res.json({ intent: 'GENERAL_CHAT', destination: null });
    }

    // ── NAVIGATION — only explicit action commands ────────────────────────
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

    // ── PLACE_SEARCH — nearby named places, not physical obstacles ────────
    // Only match when the user names a real place type (hospital, cafe, etc.)
    const placeSearchKw = [
      'where is the', 'where is a', 'find a ', 'find the ',
      'is there a ', 'is there an '
    ];
    // "nearest" / "closest" only trigger PLACE_SEARCH when followed by a named place
    const namedPlaceAfterNearest = /(?:nearest|closest)\s+(hospital|school|pharmacy|market|station|airport|bus stop|temple|mosque|church|mall|park|restaurant|cafe|shop|police|bank|hotel|atm|clinic|office|store|supermarket|metro)/i;
    const placePhraseMatch = namedPlaceAfterNearest.exec(lower);
    if (placePhraseMatch) {
      return res.json({ intent: 'PLACE_SEARCH', destination: placePhraseMatch[1].trim() });
    }
    if (placeSearchKw.some(k => lower.includes(k))) {
      const pm = message.match(/(?:find\s+(?:a|the)?|where\s+is\s+(?:the|a|an)?)\s+(.+)/i);
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

    // Build SHORT sensor context for vision (not the full persona — vision models hallucinate with too much text)
    const s = latestSensorData;
    let distHuman = 'unknown';
    if (s.dist > 0 && s.dist <= 400) {
      if (s.dist < 20) distHuman = `${s.dist}cm — VERY CLOSE, almost touching`;
      else if (s.dist <= 50) distHuman = `${s.dist}cm — about arm's length`;
      else if (s.dist <= 100) distHuman = `${s.dist}cm — about a step away`;
      else if (s.dist <= 300) distHuman = `${s.dist}cm — a few steps ahead`;
      else distHuman = `${s.dist}cm — open space`;
    } else {
      distHuman = 'no object detected within 4m (clear)';
    }

    // Dual-mode vision prompt — auto-detects obstacle vs text reading from image content
    const visionSystemPrompt = `You are a precision vision system for a visually impaired person's wearable 
device. Your camera image will always be accompanied by ultrasonic sensor 
data confirming the exact distance to the nearest object.

You have two modes. Detect which one applies from the image automatically.

---

## MODE 1 — OBSTACLE & SCENE DESCRIPTION
(Use when no text reading is the primary need)

### YOUR JOB
Describe what is physically present in the image with surgical accuracy.
You are the user's eyes — if you miss something or get it wrong, they 
could get hurt.

### RULES FOR OBJECT IDENTIFICATION

1. NEVER guess. If you are not sure what something is, describe what 
   you physically see instead:
   ✅ "There's a large dark rectangular object about a metre ahead"
   ❌ "That looks like it might be a cabinet"

2. ALWAYS lead with the closest object first — the ultrasonic confirms 
   its exact distance, use that number to anchor your description

3. NEVER skip objects just because they seem unimportant:
   - Steps and curbs — always mention
   - Poles, pillars, narrow objects — always mention
   - People and animals — always mention
   - Vehicles — always mention
   - Low hanging obstacles — always mention
   - Wet floors, uneven surfaces — always mention

4. Scan the image in this order every single time:
   STEP 1 → What is directly ahead at the sensor distance?
   STEP 2 → What is on the left?
   STEP 3 → What is on the right?
   STEP 4 → What is above head height? (overhangs, branches)
   STEP 5 → What is on the ground? (steps, curbs, puddles)
   STEP 6 → Is the path ahead clear or blocked?

5. If the ultrasonic says something is at Xcm but you don't clearly 
   see what it is — say so:
   "Something is definitely there at [distance] but I can't clearly 
   make out what it is — move carefully"

### INDOOR HAZARDS TO NEVER MISS
- Stairs going up or down
- Open doors and door frames
- Chair and table legs (low and easy to trip on)
- Countertops and shelves at head height
- People standing or moving
- Wet floor signs
- Narrow gaps between furniture

### OUTDOOR HAZARDS TO NEVER MISS
- Footpath edges and road curbs
- Steps and ramps
- Poles, bollards, signboards
- Parked vehicles sticking out
- Moving vehicles
- People and animals
- Uneven ground, potholes, puddles
- Low hanging branches or signage
- Construction barriers

### DISTANCE DESCRIPTION
Always use the ultrasonic reading as ground truth for the nearest object.
For other objects visible in the image, estimate relatively:
- Nearest object → use exact ultrasonic reading, humanised
- Other objects → "a bit further back", "well behind that", "far end"
Never say "approximately" or "roughly" — just commit to a description.

### OUTPUT FORMAT — HOW TO SPEAK
Talk like a calm, aware friend — not a report.
This gets read aloud. It should sound completely natural.

RULES:
- Only mention left and right if something relevant is there
- If the path is clear, just say so — don't list everything you see
- If there's an obstacle, say exactly where it is (left, right, or center) and what it is
- Lead with whatever is closest or most urgent based on the ultrasonic sensor
- Maximum 3-5 sentences total. Keep it punchy for text-to-speech but descriptive enough to provide a clear overview.

Examples of natural, spoken feedback:
"There's something straight ahead about 90 centimetres away — looks like a cabinet. Path's clear on both sides."
"Chair to your right, pretty close. Left side and ahead are clear."
"Watch out — something's right in front of you at 25 centimetres. You should stop."
"All clear ahead, nothing in your way for a couple of metres."

NEVER use formal labels like CENTER, LEFT, RIGHT, VERDICT or PATH VERDICT.
NEVER list every direction unnecessarily. Only speak what matters for safety.

---

## MODE 2 — TEXT READING
(Use when the image is clearly pointed at text — a sign, label, note, 
document, or currency. Switch to this mode automatically.)

### PRIORITY RULES FOR TEXT READING

1. READ EVERYTHING VISIBLE — do not summarise or paraphrase text, 
   read it out exactly as written
2. If text is partially visible or cut off, read what you can and say 
   "rest is cut off"
3. If text is in multiple languages, read all of them — Hindi and 
   English both extremely common, prioritise whichever is more prominent
4. Spell out numbers exactly — don't round or approximate
5. If text is blurry or unclear, say the most likely reading and flag it:
   "Looks like it says [X] but I'm not fully certain"

### STREET SIGNS & BOARDS
- Read the main text first, then secondary text
- Mention direction arrows if present: "Arrow pointing left"
- For shop names, read name + what type of shop if visible
- For road signs, read exactly: "Speed limit 40", "No entry", "Turn left"
- If multiple signs are visible, read nearest/most relevant first

Examples:
"That sign says 'Rajpur Road' with an arrow pointing right."
"Shop ahead says 'Sharma Medical Store — Open 24 Hours'."
"Road sign says 'No Entry' — you can't go that way."

### PRODUCT LABELS & PACKAGING
- Read product name first, then key details
- Always read: name, quantity/size, expiry date if visible
- For medicine — read name, dosage, and any warnings out loud:
  "This is Paracetamol 500mg. Take one tablet. Keep out of reach 
  of children."
- For food — read name, weight, and any allergen warnings
- If barcodes or QR codes are visible but no readable text — say so

Examples:
"This is Maggi Masala Noodles, 70 grams. Best before March 2027."
"Medicine bottle says Azithromycin 250mg. Take as directed by doctor."

### CURRENCY NOTES
- Identify denomination immediately and clearly
- Read out any serial number if asked
- Describe key visual features to help confirm authenticity:
  "This is a 500 rupee note. Gandhi portrait on the right, 
  red fort on the back. Serial number starts with 4BF."
- For foreign currency, identify country and denomination
- If note is folded or partially visible: "Looks like a 100 rupee 
  note but it's folded — I can see the 100 marking clearly"

Examples:
"That's a 200 rupee note."
"This looks like a 50 rupee note — I can see the Hampi chariot."
"Two notes here — one 500 and one 100."

### PRINTED DOCUMENTS & BOOKS
- Read text naturally from top to bottom, left to right
- For documents: read heading first, then body text
- For books: read page number if visible, then paragraph
- If handwritten: attempt to read and flag if uncertain:
  "Handwritten note, looks like it says 'call Ravi at 6pm'"
- For forms: read field labels and filled values:
  "Name field says Arjun Kumar. Date says 3rd April 2026."
- Don't skip small print if it seems important — read it

Examples:
"This looks like an Aadhaar card. Name: Priya Sharma. 
DOB: 15 January 1995."
"Page 47. The paragraph starts with: 'The forest was quiet...'"
"Receipt from Big Bazaar. Total amount: 847 rupees. 
Date: 3rd April 2026."

### MIXED SCENE (text + obstacles)
If the image has both readable text AND obstacles:
- Lead with any immediate safety hazard first
- Then read the text
"Step right in front of you — careful. The sign above it says 
'Restrooms this way, turn right'."

---

## WHAT NEVER TO SAY (both modes)

- "The image shows..." — just describe directly
- "I can see..." — just say what's there
- "It appears to be..." — commit or describe physically
- "The area looks generally clear" — too vague
- "I cannot determine..." — always give your best reading
- Never end a scene description without a path verdict
- Never end a text reading without the actual text content
- Never say "I'm not able to read that" without attempting it first

SENSOR DATA (hardware truth — use this to confirm what you see):
- Depth sensor: ${distHuman}
- Motion: ${s.pir === 1 ? 'Movement detected nearby — something is moving' : 'No movement — area is still'}
- Combined threat: ${s.dist > 0 && s.dist < 30 ? '🔴 DANGER — very close object' : (s.dist > 0 && s.dist < 50 ? '🟠 WARNING — object nearby' : '🟢 CLEAR')}`;

    const userInstruction = userPrompt
      ? `The user asked: "${userPrompt}". Do a full spatial scan: what's CENTER, LEFT, RIGHT, on the GROUND, and give a PATH VERDICT.`
      : 'Do a full spatial scan of this scene: what is CENTER (ahead), LEFT, RIGHT, on the GROUND, and is the PATH clear or blocked? Cover all zones, not just one object.';

    // ── Try vision model if image supplied ──
    if (image) {
      // Normalise base64: ensure it is a full data-URL
      const base64 = image.startsWith('data:') ? image : `data:image/jpeg;base64,${image}`;

      try {
          console.log('[Vision] Sending image to primary vision model (NVIDIA phi-4)...');
          
          const primaryVisionResp = await visionClient.chat.completions.create({
            model: 'microsoft/phi-4-multimodal-instruct',
            messages: [
              { role: 'system', content: visionSystemPrompt },
              {
                role: 'user',
                content: [
                  { type: 'text', text: userInstruction },
                  { type: 'image_url', image_url: { url: base64 } },
                ],
              },
            ],
            temperature: 0.2,
            max_tokens: 600,
            stream: false,
          });

        const description = primaryVisionResp.choices?.[0]?.message?.content?.trim();
        console.log('[Vision] Model response received:', description?.slice(0, 80));
        
        if (description) {
          // Store vision result in Supabase
          safeInsert('messages', {
            role: 'assistant',
            type: 'vision',
            username: username || 'unknown',
            content: description
          }).catch(err => console.error('Supabase vision insert error:', err));
          
          return res.json({ description, model: 'phi-4-primary', image: base64 });
        }
      } catch (visionErr) {
        console.error('[Vision] NVIDIA Vision Model failed:', visionErr.status, visionErr.message);
        
        // Let's fallback to Groq if NVIDIA fails
        try {
            console.log('[Vision] Falling back to Groq llama-3.2-11b...');
            
            const groqVisionClient = new OpenAI({
              baseURL: 'https://api.groq.com/openai/v1',
              apiKey: process.env.GROQ_API_KEY
            });

            const fallbackResp = await groqVisionClient.chat.completions.create({
              model: 'llama-3.2-11b-vision-preview',
              messages: [
                  { role: 'system', content: visionSystemPrompt },
                  { role: 'user', content: [ { type: 'text', text: userInstruction }, { type: 'image_url', image_url: { url: base64 } } ] }
              ],
              temperature: 0.2, max_tokens: 600, stream: false,
            });
            const fbDesc = fallbackResp.choices?.[0]?.message?.content?.trim();
            if (fbDesc) {
                return res.json({ description: fbDesc, model: 'llama-3.2-fallback', image: base64 });
            }
        } catch(fallbackErr) {
             console.error('[Vision] Fallback also failed:', fallbackErr.status, fallbackErr.message);
        }
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
  hardwareCameraPrompt = (req.body && req.body.prompt) ? String(req.body.prompt) : '';

  // OPTIMIZED: Check for pre-warmed image first (Vision Pre-warm)
  const preloadAge = Date.now() - lastPreloadedImage.timestamp;
  if (lastPreloadedImage.data && preloadAge < 5000) {
    console.log(`[Pre-warm] Using preloaded image (age: ${preloadAge}ms)`);
    const fetch = require('node-fetch');
    fetch(`http://localhost:${PORT}/api/vision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: lastPreloadedImage.data, prompt: hardwareCameraPrompt, source: 'pi', username: req.body.username || 'unknown' }),
    })
    .then(r => r.json())
    .then(visionData => {
      res.json({ description: visionData.description, source: 'pi', preloaded: true, captureAge: preloadAge, image: visionData.image });
    })
    .catch(err => {
      console.error('[Pre-warm] Vision processing failed:', err.message);
      res.status(500).json({ error: 'Vision analysis failed' });
    });
    lastPreloadedImage = { data: null, timestamp: 0, prompt: '' };
    hardwareCameraPrompt = '';
    return;
  }

  // OPTIMIZED: Use WebSocket to push CAPTURE_NOW instantly instead of polling flag
  if (wsCAM && wsCAM.readyState === 1) {
    console.log('[WS-CAM] Sending CAPTURE_NOW via WebSocket');
    wsCAM.send('CAPTURE_NOW');
  } else {
    // Fallback to old polling flag if CAM WebSocket not connected
    hardwareCameraRequest = true;
  }

  hardwareCameraDeferredResponse = res; 
  
  // Use WS if available, otherwise fallback to polling
  if (wsCAM && wsCAM.readyState === 1) {
    console.log('[WS-CAM] Sending CAPTURE_NOW via WebSocket');
    wsCAM.send('CAPTURE_NOW');
  } else {
    console.log('[API] WS-CAM not available, setting hardwareCameraRequest = true for polling');
    hardwareCameraRequest = true;
  }

  setTimeout(() => {
     if (hardwareCameraDeferredResponse === res) {
         console.log('[TIMEOUT] ESP32 Camera request timed out after 45s');
         hardwareCameraDeferredResponse.status(504).json({ error: "ESP32 Camera did not respond in time." });
         hardwareCameraDeferredResponse = null;
     }
  }, 45000); 
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
      form.append('model', 'whisper-large-v3-turbo'); // OPTIMIZED: Swapped to Turbo as primary
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
        // OPTIMIZED: Fallback to distil-whisper if turbo fails
        console.warn('[STT] whisper-turbo failed, retrying with distil-whisper-large-v3-en...');
        const fallbackForm = new FormData();
        fallbackForm.append('file', wavBuffer, { filename: 'audio.wav', contentType: 'audio/wav' });
        fallbackForm.append('model', 'distil-whisper-large-v3-en');
        fallbackForm.append('language', 'en');
        const fallbackResp = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}`, ...fallbackForm.getHeaders() },
          body: fallbackForm
        });
        if (fallbackResp.ok) {
          const fbData = await fallbackResp.json();
          transcript = fbData.text || 'Empty transcription received';
        } else {
          throw new Error(`Both STT models failed`);
        }
      } else {
        const data = await response.json();
        if (data && data.text) {
          transcript = data.text;
        } else {
          transcript = "Empty transcription received";
        }
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
      console.log(`[DEBUG] Running AI Reasoning via Llama...`);
      const now = new Date();
      // Adjust to IST as that seems to be the user's timezone from the logs
      const timeStr = now.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
      const dateStr = now.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', month: 'long', day: 'numeric' });
      
      const httpSensorCtx = buildSensorContext();
      const chatPromise = groqClient.chat.completions.create({
        model: 'llama-3.1-8b-instant',
        messages: [
          { role: 'system', content: VISION_PERSONA + `\n\nThe current time is ${timeStr}, ${dateStr}. Respond concisely (under 30 words). The user might call you 'Jenny' or other names — just respond helpfully. Current sensor readings:\n` + httpSensorCtx },
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
  const isPreload = req.query.preload === 'true'; // OPTIMIZED: Pre-warm capture detection
  console.log(`\n[HARDWARE] 📷 Image received from ESP/Pi! IP: ${req.ip} Data size: ${req.file ? req.file.size : 'base64'} bytes (preload: ${isPreload})`);
  try {
    const fetch = require('node-fetch');
    let imageData = req.body.image; // JSON base64

    // If multipart file upload
    if (req.file) {
      imageData = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    }

    if (!imageData) return res.status(400).json({ error: 'No image provided' });

    // OPTIMIZED: Image inversion is now handled by the ESP32-CAM hardware directly.
    // This entirely frees up the Node.js event loop, preventing severe lag spikes.

    try {
      const pureBase64 = imageData.includes('base64,') ? imageData.split('base64,')[1] : imageData;
      latestFrame = Buffer.from(pureBase64, 'base64');
    } catch(e) {}

    // OPTIMIZED: If this is a preload capture, store it and return immediately
    if (isPreload) {
      lastPreloadedImage = { data: imageData, timestamp: Date.now(), prompt: '' };
      console.log(`[Pre-warm] Stored preloaded image (${imageData.length} chars)`);
      return res.json({ stored: true, preloaded: true });
    }
    
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
      preloaded: false, // OPTIMIZED: metadata flag
      captureAge: 0,
      image: visionData.image,
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

// Live spatial sensor cache — updated by ESP32 over WebSocket
let latestSensorData = { pir: 0, dist: -1, ir: 0 };

// SERVER-SIDE ULTRASONIC SMOOTHING — sliding window median filter
// Second defence layer on top of firmware's median-of-5 + EMA
const DIST_HISTORY_SIZE = 5;
let distHistory = [];         // Sliding window of recent readings
let lastValidDist = -1;       // Last accepted distance
let lastDistTimestamp = 0;    // For spike rejection timing

function serverSmoothedDist(rawDist) {
  const now = Date.now();
  
  // Reject out-of-range values
  if (rawDist <= 0 || rawDist > 400) {
    // If we haven't had a valid reading in >3s, accept that nothing is in range
    if (now - lastDistTimestamp > 3000) {
      lastValidDist = -1;
      distHistory = [];
    }
    return lastValidDist;
  }

  // Spike rejection: if distance jumped >150cm in <500ms, likely a ghost echo
  const elapsed = now - lastDistTimestamp;
  if (lastValidDist > 0 && elapsed < 500 && Math.abs(rawDist - lastValidDist) > 150) {
    // Ignore this reading — keep previous value
    return lastValidDist;
  }

  // Add to sliding window
  distHistory.push(rawDist);
  if (distHistory.length > DIST_HISTORY_SIZE) distHistory.shift();

  // Median of the window
  const sorted = [...distHistory].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];

  lastValidDist = median;
  lastDistTimestamp = now;
  return median;
}

// OPTIMIZED: WebSocket reference to ESP32-CAM for instant capture commands
let wsCAM = null;

// OPTIMIZED: Sensor mode tracking for AI context prioritization
let lastSensorMode = 'IDLE';

// OPTIMIZED: Vision Pre-warm — speculative capture cache
let lastPreloadedImage = { data: null, timestamp: 0, prompt: '' };
let lastPreloadCaptureTime = 0;

// OPTIMIZED: GPS Reverse Geocoding Cache
let geocodeCache = { name: null, lat: 0, lng: 0, cachedAt: 0 };

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

// SENSOR DEBUG — live view of what the ultrasonic is actually reading
app.get('/api/pi/sensor-debug', (req, res) => {
  const now = Date.now();
  const sensorAge = lastSensorTimestamp ? (now - lastSensorTimestamp) : -1;
  res.json({
    current: latestSensorData,
    filter: {
      lastValidDist,
      emaDistance: 'firmware-side',
      distHistory: [...distHistory],
      lastDistTimestamp: lastDistTimestamp ? new Date(lastDistTimestamp).toISOString() : 'never',
    },
    timing: {
      sensorAgeMs: sensorAge,
      sensorAgeLabel: sensorAge < 0 ? 'never received' : sensorAge < 1000 ? 'live' : sensorAge < 5000 ? 'recent' : 'stale',
      lastSensorTimestamp: lastSensorTimestamp ? new Date(lastSensorTimestamp).toISOString() : 'never',
    },
    micOnline: (now - hardwareHealth.lastMicPoll) <= 15000,
    sensorMode: lastSensorMode,
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
  
  // If the ESP is off or ignoring us, timeout after 45 seconds
  setTimeout(() => {
     if (hardwareAudioDeferredResponse === res) {
         console.log('[TIMEOUT] ESP32 Mic request timed out after 45s');
         hardwareAudioDeferredResponse.status(504).json({ error: "ESP32 did not respond in time.", transcript: "Hardware Timeout" });
         hardwareAudioDeferredResponse = null;
         hardwareIsCurrentlyListening = false;
     }
  }, 45000); 
});
// ─────────────────────────────────────────────────────────────────────────────

// New SSE endpoint for client-side vision processing
app.get('/api/vision/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  const streamInterval = setInterval(() => {
    // Tell ESP32-CAM to capture a frame silently, limit to ~2-3 FPS to prevent hardware overload
    const now = Date.now();
    if (wsCAM && wsCAM.readyState === 1 && (!global.lastStreamReq || now - global.lastStreamReq > 400)) {
      global.lastStreamReq = now;
      wsCAM.send('PRELOAD_CAPTURE'); 
    }

    if (latestFrame) {
      res.write(`data: ${latestFrame.toString('base64')}\n\n`);
    } else {
      res.write(`data: offline\n\n`);
    }
  }, 200);

  req.on('close', () => {
    clearInterval(streamInterval);
  });
});

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
    let isCAM = false; // OPTIMIZED: Track if this connection is ESP32-CAM
    
    ws.on('message', async (message, isBinary) => {

      if (!isBinary) {
        const text = message.toString();

        // OPTIMIZED: ESP32-CAM identification — separate from MIC
        if (text.startsWith('{"type":"ESP32_CAM"}')) {
          isCAM = true;
          wsCAM = ws;
          hardwareHealth.lastCamPoll = Date.now();
          console.log('[WS-CAM] ESP32-CAM identified and registered');
          return;
        }

        // Keep the dashboard health indicator alive for MIC connections
        if (!isCAM) {
          hardwareHealth.lastMicPoll = Date.now();
        } else {
          hardwareHealth.lastCamPoll = Date.now();
          return; // CAM only sends identification, no other text messages
        }

        // ─── SENSOR TELEMETRY ───
        if (text.startsWith('{"type":"sensors"')) {
          try {
            const parsed = JSON.parse(text);
            // OPTIMIZED: Support compact keys (u, p, i) with fallback to old keys
            latestSensorData.pir = parsed.p !== undefined ? parsed.p : (parsed.pir || 0);
            const rawDist = parsed.u !== undefined ? parsed.u : (parsed.dist || -1);
            latestSensorData.dist = serverSmoothedDist(rawDist); // Apply server-side median filter
            latestSensorData.ir = parsed.i !== undefined ? parsed.i : (parsed.ir || 0);
            lastSensorTimestamp = Date.now();
            
            // DEBUG: Log raw vs smoothed every 5 seconds
            if (!global._lastSensorLog || Date.now() - global._lastSensorLog > 5000) {
              console.log(`[SENSOR] raw=${rawDist}cm → smoothed=${latestSensorData.dist}cm | PIR=${latestSensorData.pir} | mode=${parsed.mode || '?'} | history=[${distHistory.join(',')}]`);
              global._lastSensorLog = Date.now();
            }
            
            // OPTIMIZED: Store sensor mode for AI context prioritization
            if (parsed.mode) lastSensorMode = parsed.mode;

            // OPTIMIZED: Vision Pre-warm — speculative capture on proximity
            const dist = latestSensorData.dist;
            const now = Date.now();
            if (dist > 0 && dist < 80 && wsCAM && wsCAM.readyState === 1 && (now - lastPreloadCaptureTime > 3000)) {
              console.log(`[Pre-warm] Ultrasonic ${dist}cm < 80cm — sending PRELOAD_CAPTURE to CAM`);
              wsCAM.send('PRELOAD_CAPTURE');
              lastPreloadCaptureTime = now;
            }
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

          if (audioChunks.length === 0) {
            streamClients.forEach(client => {
              client.write(`data: {"event": "AUDIO_RESULT", "data": {"text": "I didn't capture any audio. Please try speaking closer to the microphone.", "transcript": ""}}\n\n`);
            });
            return;
          }
          
          let transcript = "";
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
            
            // OPTIMIZED: Switch STT to distil-whisper-large-v3-en with fallback
            const FormData = require('form-data');
            const fetch = require('node-fetch');
            const form = new FormData();
            form.append('file', wavBuffer, { filename: 'audio.wav', contentType: 'audio/wav' });
            form.append('model', 'distil-whisper-large-v3-en'); // OPTIMIZED: Faster STT
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
              // OPTIMIZED: Fallback to whisper-large-v3-turbo
              console.warn('[WS-STT] distil-whisper failed, retrying with whisper-large-v3-turbo...');
              const fallbackForm = new FormData();
              fallbackForm.append('file', wavBuffer, { filename: 'audio.wav', contentType: 'audio/wav' });
              fallbackForm.append('model', 'whisper-large-v3-turbo');
              fallbackForm.append('language', 'en');
              const fallbackResp = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}`, ...fallbackForm.getHeaders() },
                body: fallbackForm
              });
              if (fallbackResp.ok) {
                const fbData = await fallbackResp.json();
                transcript = fbData.text || 'Empty transcription';
              } else {
                transcript = "Error reading audio";
              }
            }
            
            console.log(`[WS] Transcript: ${transcript}`);
            
            // OPTIMIZED: Fire-and-forget Supabase write
            safeInsert('messages', { role: 'user', content: transcript, type: 'voice', username: "hardware_user" }).catch(() => {});

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

            // Build spatial awareness context using shared helper
            const spatialContext = buildSensorContext();
            // OPTIMIZED: Include sensor mode in context for prioritization
            const modeNote = lastSensorMode === 'ALERT' ? '\n⚠️ SENSOR MODE: HIGH ALERT — prioritize spatial awareness in your response.' : '';
            console.log(`[WS] Spatial Context: ${spatialContext}`);

            const now = new Date();
            const timeStr = now.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
            const dateStr = now.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', month: 'long', day: 'numeric' });

            const systemPrompt = VISION_PERSONA + `\n\nThe current time is ${timeStr}, ${dateStr}. This is a VOICE interaction — keep your response under 30 words. The user spoke through their wearable microphone. Current sensor readings:\n` + spatialContext + modeNote;

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
              new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 20000))
            ]);
            
            aiResponse = chatCompletion.choices[0].message.content.trim();
            console.log(`[WS] AI: ${aiResponse}`);
            
            // OPTIMIZED: Fire-and-forget Supabase write
            safeInsert('messages', { role: 'assistant', content: aiResponse, type: 'voice', username: "hardware_user" }).catch(() => {});

            const finalData = { text: aiResponse, transcript: transcript };

            streamClients.forEach(client => {
              client.write(`data: {"event": "AUDIO_RESULT", "data": ${JSON.stringify(finalData)}}\n\n`);
            });
            
          } catch (err) {
            console.error('[WS] Process Error:', err);
            streamClients.forEach(client => {
              client.write(`data: {"event": "AUDIO_RESULT", "data": {"text": "I encountered an error processing your voice: ${err.message}", "transcript": ${JSON.stringify(transcript || "")}}}\n\n`);
            });
          }
        }
      } else {
        if (isCAM) {
          latestFrame = message; // Overwrite with latest CAM frame
        } else {
          // Binary audio format
          audioChunks.push(message);
        }
      }
    });

    ws.on('close', () => {
      // OPTIMIZED: Clean up CAM reference on disconnect
      if (isCAM) {
        wsCAM = null;
        console.log('[WS-CAM] ESP32-CAM Disconnected');
      } else {
        console.log('[WS] ESP32-MIC Disconnected');
      }
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
