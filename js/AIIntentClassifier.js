/**
 * AIIntentClassifier.js — Vision AID Multi-Intent Brain
 *
 * Classifies any user utterance into one of five intents:
 *   NAVIGATION    — explicit navigation commands only ("take me to", "navigate to")
 *   VISION        — visual analysis / camera usage
 *   LOCATION_INFO — user asking about their current position ("where am I")
 *   PLACE_SEARCH  — asking about nearby places, no map opened ("nearest metro")
 *   GENERAL_CHAT  — everything else
 *
 * Classification strategy (layered, fastest-first):
 *   1. Pattern matching  → instant, zero-latency
 *   2. Server classify   → calls /api/ai/classify (also rule-based, no LLM delay)
 *
 * Returns a classification object:
 *   { intent: string, destination: string|null, confidence: 'pattern'|'api'|'fallback' }
 */

const AIIntentClassifier = (() => {

  /* ── NAVIGATION: only explicit action verbs ── */
  const NAV_PATTERNS = [
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

  /* ── VISION patterns ── */
  const VISION_PATTERNS = [
    /^(?:see|look|vision|scan|describe)$/i,
    /(?:what|who|describe|tell\s+me\s+about|identify|analys?e|analyze|look\s+at|see|scan|read|detect|recognize|check)\s+(?:what\s+is\s+)?(?:in\s+front\s+of\s+me|around\s+me|ahead|this|that|here|this\s+image|this\s+photo|my\s+surroundings?)/i,
    /(?:what\s+(?:do\s+i\s+)?see|what\s+(?:am\s+i\s+looking\s+at|is\s+this|is\s+that|is\s+in\s+front))/i,
    /(?:what\s+is|what\s+are|read|tell\s+me\s+what\s+is)\s+(?:written\s+)?(?:in\s+front\s+of\s+me|here|there|on\s+it|on\s+the\s+screen|in\s+this\s+image|in\s+this\s+photo)/i,
    /(?:read|tell\s+me|what\s+is)\s+(?:what(?:'s|\s+is)?\s+written|the\s+text|the\s+sign|the\s+words)\s+(?:in\s+front\s+of\s+me|here|there|on\s+it|on\s+the\s+screen|in\s+this\s+image|in\s+this\s+photo)/i,
    /(?:read|tell\s+me|what\s+is|identify)\s+(?:the\s+)?(?:currency|money|note|notes|bill|bills|receipt|menu|label|sign|board|package|bottle|can|serial\s+number|barcode|text)/i,
    /(?:what\s+is\s+written\s+on|read\s+the|read\s+what\s+is\s+written\s+on)\s+(?:this\s+)?(?:currency|money|note|notes|bill|bills|receipt|menu|label|sign|board|package|bottle|can|paper|document)/i,
    /(?:use|switch\s+to|open|start|activate|force)\s+(?:the\s+)?(?:device\s+)?(?:camera\s+input|device\s+camera|inbuilt\s+camera|built[-\s]?in\s+camera|webcam|browser\s+camera)/i,
    /(?:use|open|start|activate)\s+(?:the\s+)?(?:camera|vision|object\s+detection)/i,
    /(?:is\s+there\s+(?:any|a|an)\s+(?:person|car|obstacle|sign|text|object)|read\s+(?:the\s+)?(?:sign|text|label|menu|board))/i,
    /(?:what\s+(?:color|colour)|describe\s+(?:my\s+)?surroundings?|tell\s+me\s+what\s+you\s+see)/i,
    /detect\s+(?:objects?|people|obstacles?|text|signs?)/i,
  ];

  /* ── LOCATION_INFO: user asking about their own position ── */
  const LOCATION_INFO_KW = [
    'where am i', 'my location', 'current location', 'my current location',
    'what is my location', 'where are we', 'what city am i in', 'what area am i in',
  ];

  /* ── PLACE_SEARCH: nearby info queries — NO map, NO navigation ── */
  const PLACE_SEARCH_KW = [
    'nearest', 'closest', 'near me', 'nearby',
    'where is the', 'where is a', 'find a ', 'find the ',
    'is there a ', 'is there an ', 'how far is', 'distance to'
  ];

  /**
   * Extract a navigation destination from NAV_PATTERNS.
   */
  function extractDestination(msg) {
    for (const pattern of NAV_PATTERNS) {
      const m = msg.trim().match(pattern);
      if (m && m[1]) return m[1].replace(/[?.!,;]+$/, '').trim();
    }
    return null;
  }

  /**
   * Synchronous pattern-based classification (instant).
   * Returns null if undecided — never touches the network.
   */
  function classifyByPattern(msg) {
    let lower = msg.toLowerCase().trim();
    // Normalize common typos
    lower = lower.replace(/what'?s/g, 'what is')
           .replace(/infront/g, 'in front')
           .replace(/wriotten/g, 'written')
           .replace(/surounding/g, 'surrounding');

    // Vision check first (very specific)
    for (const p of VISION_PATTERNS) {
      if (p.test(lower)) return { intent: 'VISION', destination: null, confidence: 'pattern' };
    }

    // Navigation — explicit action verbs ONLY
    for (const p of NAV_PATTERNS) {
      const m = lower.match(p);
      if (m && m[1]) {
        const dest = m[1].replace(/[?.!,;]+$/, '').trim();
        if (dest.length >= 2) return { intent: 'NAVIGATION', destination: dest, confidence: 'pattern' };
      }
    }

    // Location info — user asking about current position
    // Exclude if asking for distance or routing to another place
    const isDistanceQuery = /how\s+far|distance|route|navigate|directions|where\s+is/i.test(lower);
    if (!isDistanceQuery && LOCATION_INFO_KW.some(k => lower.includes(k))) {
      return { intent: 'LOCATION_INFO', destination: null, confidence: 'pattern' };
    }

    // Place search — info about nearby place, no navigation
    if (PLACE_SEARCH_KW.some(k => lower.includes(k))) {
      const pm = msg.match(/(?:nearest|closest|find\s+(?:a|the)?|where\s+is\s+(?:the|a|an)?|near\s+me|how\s+far\s+is\s+(?:the|a|an)?|distance\s+to\s+(?:the|a|an)?)\s+(.+)/i);
      let dest = pm ? pm[1] : null;
      if (dest) {
          dest = dest.replace(/\b(?:is\s+)?from\s+(?:my\s+location|here|me)\b/i, '')
                     .replace(/[?.!,;]+$/, '')
                     .trim();
      }
      return { intent: 'PLACE_SEARCH', destination: dest, confidence: 'pattern' };
    }

    return null; // undecided
  }

  /**
   * Server-side classify fallback — also rule-based, no LLM, instant.
   * Has a 5-second abort timeout so the chat is never silently blocked.
   */
  async function classifyByAPI(msg) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const resp = await fetch(getBackendUrl('/api/ai/classify'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) throw new Error('classify api error');
      const data = await resp.json();
      return {
        intent: data.intent || 'GENERAL_CHAT',
        destination: data.destination || null,
        confidence: 'api',
      };
    } catch (e) {
      console.warn('[AIIntentClassifier] classify failed, defaulting to GENERAL_CHAT', e.message);
      return { intent: 'GENERAL_CHAT', destination: null, confidence: 'fallback' };
    }
  }

  /**
   * Main classify function — always resolves, never throws.
   * @param {string} msg
   * @returns {Promise<{intent: string, destination: string|null, confidence: string}>}
   */
  async function classify(msg) {
    if (!msg || typeof msg !== 'string' || msg.trim().length === 0) {
      return { intent: 'GENERAL_CHAT', destination: null, confidence: 'empty' };
    }

    // Fast pass: local pattern match (zero-latency)
    const patternResult = classifyByPattern(msg);
    if (patternResult) return patternResult;

    // Fallback: server rule-based classify (with 5 s timeout)
    return await classifyByAPI(msg);
  }

  return { classify, classifyByPattern, extractDestination };
})();
