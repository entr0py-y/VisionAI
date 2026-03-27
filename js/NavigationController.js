/**
 * NavigationController.js — Vision AID Navigation Orchestrator
 *
 * Exposes a single public function: navigateTo(destinationText)
 * Orchestrates geocoding, map initialization, routing, and voice guidance.
 *
 * Integration points:
 *   - openModal('mobility')  → existing function in index.html that opens the Mobility modal
 *   - MobilityMap             → handles Leaflet map rendering and GPS tracking
 *   - VoiceGuide              → handles all spoken feedback
 *   - addChatMessage()        → existing function to show messages in the AI chat
 */

const NavigationController = (() => {
  let isNavigating = false;
  let currentDestination = null;
  let voiceInstructionIndex = 0;
  let voiceInstructions = [];
  let voiceInterval = null;

  /**
   * Main entry point: Navigate to a plain-text destination.
   * @param {string} destinationText — e.g. "City Hospital", "Central Park"
   */
  async function navigateTo(destinationText) {
    if (!destinationText || !destinationText.trim()) {
      VoiceGuide.speak('Please specify a destination.');
      return;
    }

    currentDestination = destinationText.trim();

    // Confirm intent via voice and chat
    VoiceGuide.speak(`Opening navigation to ${currentDestination}.`);
    if (typeof addChatMessage === 'function') {
      addChatMessage('ai', `🗺️ Opening navigation to ${currentDestination}...`);
    }

    // Step 1: Check internet connectivity
    if (!navigator.onLine) {
      VoiceGuide.announceError('offline');
      if (typeof addChatMessage === 'function') {
        addChatMessage('ai', '⚠️ No internet connection. Navigation is unavailable.');
      }
      return;
    }

    // Step 2: Get user's current location
    let userCoords;
    try {
      userCoords = await getUserLocation();
    } catch (err) {
      VoiceGuide.announceError('no-location');
      if (typeof addChatMessage === 'function') {
        addChatMessage('ai', '⚠️ Location access is required for navigation. Please enable GPS.');
      }
      return;
    }

    // Step 3: Geocode the destination
    let destCoords;
    try {
      destCoords = await geocodeDestination(currentDestination, userCoords);
    } catch (err) {
      VoiceGuide.announceError('not-found');
      if (typeof addChatMessage === 'function') {
        addChatMessage('ai', `⚠️ Sorry, I couldn't find "${currentDestination}". Try a more specific name.`);
      }
      return;
    }

    // Step 4: Open the Mobility modal (existing function from index.html)
    if (typeof openModal === 'function') {
      openModal('mobility');
    }

    // Step 5: Wait for modal animation, then initialize map
    setTimeout(() => {
      initializeNavigation(userCoords, destCoords, currentDestination);
    }, 500);
  }

  /**
   * Get user location — tries GPS first, then IP fallback.
   * @returns {Promise<{lat: number, lng: number}>}
   */
  function getUserLocation() {
    return new Promise((resolve, reject) => {
      if (!('geolocation' in navigator)) {
        // Try IP fallback
        ipFallback().then(resolve).catch(reject);
        return;
      }

      let completed = false;
      const fallbackTimer = setTimeout(() => {
        if (!completed) {
          completed = true;
          ipFallback().then(resolve).catch(reject);
        }
      }, 10000);

      navigator.geolocation.getCurrentPosition(
        (pos) => {
          if (!completed) {
            completed = true;
            clearTimeout(fallbackTimer);
            resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude });
          }
        },
        (err) => {
          if (!completed) {
            completed = true;
            clearTimeout(fallbackTimer);
            ipFallback().then(resolve).catch(reject);
          }
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
      );
    });
  }

  /**
   * IP-based location fallback.
   */
  async function ipFallback() {
    const res = await fetch('https://get.geojs.io/v1/ip/geo.json');
    const data = await res.json();
    if (data.latitude && data.longitude) {
      return { lat: parseFloat(data.latitude), lng: parseFloat(data.longitude) };
    }
    throw new Error('IP fallback failed');
  }

  /**
   * Geocode a destination string using Nominatim API.
   * Biases search near the user's current location for relevance.
   * @param {string} query
   * @param {{lat: number, lng: number}} userCoords
   * @returns {Promise<{lat: number, lng: number, displayName: string}>}
   */
  async function geocodeDestination(query, userCoords) {
    const params = new URLSearchParams({
      q: query,
      format: 'json',
      limit: '1',
      addressdetails: '1',
    });

    // Bias search near user's location (viewbox + bounded)
    if (userCoords) {
      const delta = 0.5; // ~50km radius bias
      params.set('viewbox', `${userCoords.lng - delta},${userCoords.lat + delta},${userCoords.lng + delta},${userCoords.lat - delta}`);
      params.set('bounded', '0'); // Preference not restriction
    }

    const res = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
      headers: { 'User-Agent': 'VisionAID-Navigation/1.0' },
    });

    if (!res.ok) throw new Error('Nominatim request failed');

    const results = await res.json();
    if (!results || results.length === 0) {
      throw new Error('No results found');
    }

    const result = results[0];
    return {
      lat: parseFloat(result.lat),
      lng: parseFloat(result.lon),
      displayName: result.display_name,
    };
  }

  /**
   * Initialize the map and plot the route after modal is open.
   */
  function initializeNavigation(userCoords, destCoords, destName) {
    isNavigating = true;

    // Initialize MobilityMap in the container
    MobilityMap.init('mobilityMapContainer');

    // Set user position
    MobilityMap.updateUserPosition(userCoords.lat, userCoords.lng);

    // Plot route with turn-by-turn callback
    MobilityMap.setRoute(userCoords, destCoords, destName, (instructions, destination) => {
      if (!instructions) {
        VoiceGuide.announceError('route-failed');
        if (typeof addChatMessage === 'function') {
          addChatMessage('ai', '⚠️ Could not calculate a route to that destination.');
        }
        return;
      }

      // Announce navigation start
      VoiceGuide.announceStart(destination);

      if (typeof addChatMessage === 'function') {
        addChatMessage('ai', `✅ Route found to ${destination}. Follow the voice instructions.`);
      }

      // Start speaking turn-by-turn instructions
      startVoiceNavigation(instructions, destination);
    });
  }

  /**
   * Speak turn-by-turn instructions sequentially.
   */
  function startVoiceNavigation(instructions, destination) {
    voiceInstructions = instructions;
    voiceInstructionIndex = 0;

    // Clear any previous interval
    if (voiceInterval) clearInterval(voiceInterval);

    // Speak first instruction after a short delay
    setTimeout(() => {
      if (voiceInstructions.length > 0) {
        VoiceGuide.announceTurn(voiceInstructions[0]);
        voiceInstructionIndex = 1;
      }
    }, 3000);

    // Speak subsequent instructions at intervals
    voiceInterval = setInterval(() => {
      if (voiceInstructionIndex >= voiceInstructions.length) {
        // All instructions spoken — announce arrival
        VoiceGuide.announceArrival(destination);
        if (typeof addChatMessage === 'function') {
          addChatMessage('ai', `📍 You have arrived at ${destination}.`);
        }
        stopNavigation();
        return;
      }

      VoiceGuide.announceTurn(voiceInstructions[voiceInstructionIndex]);
      voiceInstructionIndex++;
    }, 8000); // 8 seconds between instructions
  }

  /**
   * Stop active navigation.
   */
  function stopNavigation() {
    isNavigating = false;
    currentDestination = null;
    voiceInstructions = [];
    voiceInstructionIndex = 0;
    if (voiceInterval) {
      clearInterval(voiceInterval);
      voiceInterval = null;
    }
    VoiceGuide.stop();
  }

  /**
   * Check if navigation is currently active.
   */
  function isActive() {
    return isNavigating;
  }

  return {
    navigateTo,
    stopNavigation,
    isActive,
  };
})();
