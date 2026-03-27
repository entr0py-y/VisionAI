/**
 * AIIntentParser.js — Vision AID Navigation Intent Detection
 *
 * Intercepts outgoing chat messages and checks for navigation intent
 * BEFORE they are sent to the AI backend.
 *
 * Integration point: Called at the top of the sendChat() function in index.html.
 * If navigation intent is detected, it calls NavigationController.navigateTo()
 * and returns true to signal that the message should NOT be sent to the AI backend.
 */

const AIIntentParser = (() => {
  // Navigation intent patterns — order matters (most specific first)
  const NAV_PATTERNS = [
    /(?:guide\s+me\s+to|navigate\s+to|take\s+me\s+to|directions?\s+to|how\s+(?:do|can)\s+i\s+get\s+to|bring\s+me\s+to|walk\s+me\s+to|show\s+(?:me\s+)?(?:the\s+)?(?:way|route|path)\s+to|go\s+to|head\s+to|find\s+(?:the\s+)?(?:way|route)\s+to|lead\s+me\s+to|route\s+to|get\s+(?:me\s+)?to)\s+(.+)/i,
    /(?:i\s+(?:want|need)\s+to\s+(?:go|get|navigate|walk|reach)\s+to)\s+(.+)/i,
    /(?:where\s+is|how\s+(?:to|do\s+i)\s+(?:reach|find))\s+(.+?)(?:\s*\?|$)/i,
  ];

  /**
   * Check if a message contains a navigation intent.
   * @param {string} message — the user's chat message
   * @returns {{ isNavigation: boolean, destination: string | null }}
   */
  function checkIntent(message) {
    if (!message || typeof message !== 'string') {
      return { isNavigation: false, destination: null };
    }

    const trimmed = message.trim();

    for (const pattern of NAV_PATTERNS) {
      const match = trimmed.match(pattern);
      if (match && match[1]) {
        let destination = match[1].trim();

        // Clean up trailing punctuation
        destination = destination.replace(/[?.!,;]+$/, '').trim();

        // Reject very short or likely non-destination strings
        if (destination.length < 2) continue;

        return {
          isNavigation: true,
          destination: destination,
        };
      }
    }

    return { isNavigation: false, destination: null };
  }

  /**
   * Process a chat message for navigation intent.
   * If intent is detected, triggers NavigationController and returns true.
   * If no intent, returns false (message should go through normal AI flow).
   *
   * @param {string} message — the user's chat message
   * @returns {boolean} — true if navigation was handled (skip AI backend)
   */
  function processMessage(message) {
    const intent = checkIntent(message);

    if (intent.isNavigation && intent.destination) {
      // Trigger navigation — do NOT send to AI backend
      NavigationController.navigateTo(intent.destination);
      return true; // Signal: message was handled
    }

    return false; // Signal: pass through to AI backend
  }

  return {
    checkIntent,
    processMessage,
  };
})();
