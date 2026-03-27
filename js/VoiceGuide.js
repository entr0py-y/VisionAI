/**
 * VoiceGuide.js — Vision AID Voice Navigation Utility
 *
 * Provides spoken feedback for navigation events using the Web Speech Synthesis API.
 * Reuses the same SpeechSynthesis approach as the existing speakText() in index.html,
 * but is scoped specifically to navigation announcements.
 */

const VoiceGuide = (() => {
  // Cancel any current speech and speak new text immediately
  function speak(text) {
    if (!("speechSynthesis" in window)) {
      console.warn("VoiceGuide: Speech synthesis not supported");
      return;
    }
    window.speechSynthesis.pause();
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.9; // Slightly slower for navigation clarity
    utterance.pitch = 1.0;
    utterance.volume = 1.0;
    utterance.lang = "en-US";
    utterance.onend = () => {};
    utterance.onerror = (e) => {
      console.warn("VoiceGuide: Speech error", e.error);
    };
    window.speechSynthesis.speak(utterance);
  }

  // Stop all speech immediately
  function stop() {
    if ("speechSynthesis" in window) {
      window.speechSynthesis.pause();
      window.speechSynthesis.cancel();
    }
  }

  // Announce navigation start
  function announceStart(destination) {
    speak(`Navigation started. Head towards ${destination}.`);
  }

  // Announce a turn instruction
  function announceTurn(instruction) {
    speak(instruction);
  }

  // Announce approaching destination
  function announceApproaching(destination) {
    speak(`You are approaching ${destination}.`);
  }

  // Announce arrival
  function announceArrival(destination) {
    speak(`You have arrived at ${destination}.`);
  }

  // Announce errors
  function announceError(errorType) {
    const messages = {
      "no-location": "Location access is required for navigation.",
      "not-found": "Sorry, I could not find that location.",
      offline: "No internet connection. Navigation is unavailable.",
      "route-failed": "Could not calculate a route to that destination.",
    };
    speak(messages[errorType] || "An error occurred during navigation.");
  }

  return {
    speak,
    stop,
    announceStart,
    announceTurn,
    announceApproaching,
    announceArrival,
    announceError,
  };
})();
