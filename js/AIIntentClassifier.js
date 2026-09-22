/**
 * AIIntentClassifier.js — Vision AID Multi-Intent Brain
 *
 * Classifies any user utterance into one of five intents:
 *   NAVIGATION    — explicit navigation commands only ("take me to", "navigate to")
 *   VISION        — visual analysis / camera usage
 *   LOCATION_INFO — user asking about their current position ("where am I")
 *   PLACE_SEARCH  — asking about nearby places ("nearest metro", "find a hospital")
 *   GENERAL_CHAT  — everything else (DEFAULT — fastest path)
 *
 * Speed strategy:
 *   1. Pattern match obvious commands → instant (0ms)
 *   2. If message has NO spatial/device words → GENERAL_CHAT instantly (0ms)
 *   3. Only if ambiguous (has spatial words but pattern didn't match) → ask LLM (~500ms)
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
    /i\s+(?:want|need)\s+to\s+(?:go|get|navigate|reach)\s+to\s+(.+)/i,
    /(?:go|head|get)\s+to\s+(.+)/i,
  ];

  /* ── VISION patterns — only when clearly asking about physical surroundings ── */
  const VISION_PATTERNS = [
    /^(?:see|look|vision|scan|describe|camera)$/i,
    /(?:what|who|describe|identify|look\s+at|see|scan|read|detect|check)\s+(?:in\s+front\s+of\s+me|around\s+me|ahead|this|that|my\s+surroundings?)/i,
    /(?:what\s+(?:do\s+i\s+)?see|what\s+(?:am\s+i\s+looking\s+at|is\s+this|is\s+that|is\s+in\s+front))/i,
    /(?:what\s+is|read)\s+(?:written\s+)?(?:in\s+front\s+of\s+me|here|there|on\s+it|on\s+the\s+screen)/i,
    /(?:use|open|start|activate)\s+(?:the\s+)?(?:camera|vision|webcam)/i,
    /(?:what\s+(?:color|colour)|describe\s+(?:my\s+)?surroundings?|tell\s+me\s+what\s+you\s+see)/i,
    /detect\s+(?:objects?|people|obstacles?|text|signs?)/i,
  ];

  /* ── LOCATION_INFO: user asking about their own position ── */
  const LOCATION_INFO_KW = [
    'where am i', 'my location', 'current location', 'my current location',
    'what is my location', 'where are we', 'what city am i in', 'what area am i in',
  ];

  /* ── PLACE_SEARCH: only "nearest/closest/find + named place type" ── */
  const NAMED_PLACE_PATTERN = /(?:nearest|closest|find\s+(?:a|the|me\s+a))\s+(hospital|school|pharmacy|market|station|airport|bus\s*stop|temple|mosque|church|mall|park|restaurant|cafe|shop|police|bank|hotel|atm|clinic|office|store|supermarket|metro|gas\s*station|petrol\s*pump|toilet|restroom|bathroom|library|gym|cinema|theater|theatre)/i;

  /**
   * Words that MIGHT mean the user wants something spatial/device-related.
   * If the message contains any of these, we ask the LLM to classify.
   * If it contains NONE of these, it's definitely GENERAL_CHAT — zero delay.
   */
  const SPATIAL_HINT_WORDS = [
    'camera', 'scan', 'surroundings', 'in front', 'ahead', 'obstacle',
    'nearest', 'closest', 'nearby', 'around me', 'look at', 'detect',
    'read this', 'read that', 'read the', 'what is this', 'what is that',
    'identify', 'describe this', 'describe that', 'what do i see',
    'find a ', 'find the ', 'find me',
  ];

  function extractDestination(msg) {
    for (const pattern of NAV_PATTERNS) {
      const m = msg.trim().match(pattern);
      if (m && m[1]) return m[1].replace(/[?.!,;]+$/, '').trim();
    }
    return null;
  }

  /**
   * Synchronous pattern-based classification (instant).
   * Only catches OBVIOUS cases. Returns null if unsure.
   */
  function classifyByPattern(msg) {
    const lower = msg; // msg is already normalized by classify()

    for (const p of VISION_PATTERNS) {
      if (p.test(lower)) return { intent: 'VISION', destination: null, confidence: 'pattern' };
    }

    for (const p of NAV_PATTERNS) {
      const m = lower.match(p);
      if (m && m[1]) {
        const dest = m[1].replace(/[?.!,;]+$/, '').trim();
        if (dest.length >= 2) return { intent: 'NAVIGATION', destination: dest, confidence: 'pattern' };
      }
    }

    if (LOCATION_INFO_KW.some(k => lower.includes(k))) {
      return { intent: 'LOCATION_INFO', destination: null, confidence: 'pattern' };
    }

    const placeMatch = NAMED_PLACE_PATTERN.exec(lower);
    if (placeMatch) {
      return { intent: 'PLACE_SEARCH', destination: placeMatch[1].trim(), confidence: 'pattern' };
    }

    return null;
  }

  function classifyIntentLocally() { return 'UNKNOWN'; }

  async function classifyByAPI(msg) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort('classify_timeout'), 4000);
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
        confidence: data.source || 'api',
      };
    } catch (e) {
      console.warn('[AIIntentClassifier] classify failed, defaulting to GENERAL_CHAT', e.message);
      return { intent: 'GENERAL_CHAT', destination: null, confidence: 'fallback' };
    }
  }

  /**
   * Main classify — always resolves, never throws.
   */
  async function classify(rawMsg) {
    if (!rawMsg || typeof rawMsg !== 'string' || rawMsg.trim().length === 0) {
      return { intent: 'GENERAL_CHAT', destination: null, confidence: 'empty' };
    }

    // Normalize typos so patterns can match correctly
    const msg = rawMsg.toLowerCase().trim()
      .replace(/what'?s/g, 'what is')
      .replace(/infront/g, 'in front')
      .replace(/surounding/g, 'surrounding')
      .replace(/wriotten/g, 'written');

    const patternResult = classifyByPattern(msg);
    if (patternResult) return patternResult;

    const hasSpatialHint = SPATIAL_HINT_WORDS.some(w => msg.includes(w));
    if (!hasSpatialHint) {
      return { intent: 'GENERAL_CHAT', destination: null, confidence: 'fast' };
    }

    return await classifyByAPI(msg);
  }

  return { classify, classifyByPattern, classifyIntentLocally, extractDestination };
})();
