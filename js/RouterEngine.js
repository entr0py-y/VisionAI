/**
 * RouterEngine.js — Vision AID Central Dispatch
 *
 * Receives every user utterance, classifies intent via AIIntentClassifier,
 * then routes to the correct module:
 *   VISION        → VisionController.analyseScene()
 *   NAVIGATION    → NavigationController.navigateTo()  [only explicit commands]
 *   LOCATION_INFO → speak current GPS position, NO map
 *   PLACE_SEARCH  → answer with text info about nearby place, NO map
 *   GENERAL_CHAT  → processGeneralChat()
 *
 * This is the single entry point for ALL voice and text commands.
 * Call: RouterEngine.dispatch(userText)
 */

const RouterEngine = (() => {

  // OPTIMIZED: GPS Reverse Geocoding Cache — eliminates redundant Nominatim calls
  let _geocodeCache = { name: null, lat: 0, lng: 0, cachedAt: 0 };

  function log(msg) { console.log('[RouterEngine]', msg); }

  function uiMsg(text, type = 'ai') {
    if (typeof addChatMessage === 'function') addChatMessage(type, text);
  }

  function speak(text) {
    if (typeof speakText === 'function') speakText(text);
  }

  /**
   * Main entry point. Classifies and routes a user utterance.
   * Hard 8-second overall timeout: if classification + dispatch stalls,
   * we fall back to general chat so the user always gets a response.
   * @param {string} text — raw user speech or typed text
   */
  async function dispatch(text, pregenResponse = null) {
    if (!text || !text.trim()) {
      if (pregenResponse) {
        uiMsg(pregenResponse, 'ai');
        speak(pregenResponse);
      }
      return;
    }
    const msg = text.trim();
    log('Dispatching: ' + msg);

    let classification;
    try {
      // 8-second hard timeout on the entire classify step
      classification = await Promise.race([
        AIIntentClassifier.classify(msg),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('classify timeout')), 8000)
        ),
      ]);
    } catch (e) {
      log('Classification timed out or failed — falling back to GENERAL_CHAT');
      classification = { intent: 'GENERAL_CHAT', destination: null, confidence: 'timeout' };
    }

    log(`Intent: ${classification.intent} [${classification.confidence}] dest=${classification.destination}`);

    switch (classification.intent) {

      case 'VISION':
        await _handleVision(msg);
        break;

      case 'NAVIGATION':
        await _handleNavigation(msg, classification.destination);
        break;

      case 'LOCATION_INFO':
        await _handleLocationInfo();
        break;

      case 'PLACE_SEARCH':
        await _handlePlaceSearch(msg, classification.destination);
        break;

      case 'GENERAL_CHAT':
      default:
        await _handleChat(msg, pregenResponse);
        break;
    }
  }

  /* ─── VISION handler ─── */
  async function _handleVision(msg) {
    log('→ VISION module');
    if (typeof VisionController === 'undefined') {
      const fallback = 'Vision module is not available right now.';
      uiMsg('⚠️ ' + fallback); speak(fallback); return;
    }
    await VisionController.analyseScene(msg);
  }

  /* ─── NAVIGATION handler ─── */
  async function _handleNavigation(msg, destination) {
    log('→ NAVIGATION module, destination: ' + destination);
    if (typeof NavigationController === 'undefined') {
      const fallback = 'Navigation module is not available right now.';
      uiMsg('⚠️ ' + fallback); speak(fallback); return;
    }
    await NavigationController.navigateTo(destination || msg);
  }

  /* ─── LOCATION_INFO handler — speaks location, NO map ─── */
  async function _handleLocationInfo() {
    log('→ LOCATION_INFO handler');
    uiMsg('📍 Getting your current location...');

    if (!('geolocation' in navigator)) {
      const err = 'Location services are not available on this device.';
      uiMsg('⚠️ ' + err); speak(err); return;
    }

    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        const latStr = lat.toFixed(5);
        const lngStr = lng.toFixed(5);

        // OPTIMIZED: Check geocode cache before calling Nominatim
        const now = Date.now();
        const coordsDelta = Math.abs(lat - _geocodeCache.lat) + Math.abs(lng - _geocodeCache.lng);
        if (_geocodeCache.name && coordsDelta < 0.001 && (now - _geocodeCache.cachedAt) < 60000) {
          log('Using cached geocode result');
          const reply = `📍 You are currently in ${_geocodeCache.name}.`;
          uiMsg(reply); speak(reply); return;
        }

        // Try reverse-geocode for a human-readable name
        try {
          const res = await fetch(
            `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latStr}&lon=${lngStr}`,
            { headers: { 'User-Agent': 'VisionAID-Demo/1.0' } }
          );
          const data = await res.json();
          if (data && data.address) {
            const a = data.address;
            const place =
              a.neighbourhood || a.suburb || a.quarter || a.residential ||
              a.village || a.town || a.city || a.county || 'an unknown area';
            const city  = a.city || a.town || a.county || '';
            const state = a.state || '';
            const pretty = city && city !== place
              ? `${place}, ${city}${state ? ', ' + state : ''}`
              : `${place}${state ? ', ' + state : ''}`;
            
            // OPTIMIZED: Cache the geocoded result
            _geocodeCache = { name: pretty, lat, lng, cachedAt: Date.now() };
            
            const reply = `📍 You are currently in ${pretty}.`;
            uiMsg(reply); speak(reply); return;
          }
        } catch (_) { /* fall through to coords */ }

        const reply = `📍 Your current coordinates are ${latStr}°N, ${lngStr}°E.`;
        uiMsg(reply); speak(reply);
      },
      (err) => {
        const reply = '⚠️ I could not access your location. Please ensure GPS is enabled.';
        uiMsg(reply); speak(reply);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  }

  /* ─── PLACE_SEARCH handler — answers in text, NO map ─── */
  async function _handlePlaceSearch(msg, placeName) {
    log('→ PLACE_SEARCH handler for: ' + placeName);

    const typing = uiMsg('🔍 Searching for nearby places...');

    // Get user position first
    const getUserPos = () => new Promise((resolve, reject) => {
      if (!('geolocation' in navigator)) return reject(new Error('no geolocation'));
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
        reject,
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
      );
    });

    try {
      const coords = await getUserPos();

      // Geocode the query biased near user's position
      const params = new URLSearchParams({
        q: placeName || msg,
        format: 'json',
        limit: '1',
        addressdetails: '1',
      });
      const delta = 0.1; // ~10 km bias
      params.set('viewbox', `${coords.lng - delta},${coords.lat + delta},${coords.lng + delta},${coords.lat - delta}`);
      params.set('bounded', '0');

      const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
        headers: { 'User-Agent': 'VisionAID-Navigation/1.0' },
      });
      const results = await res.json();

      if (!results || results.length === 0) {
        const reply = `🔍 I couldn't find "${placeName || msg}" nearby. Try a more specific name.`;
        uiMsg(reply); speak(reply); return;
      }

      const top = results[0];
      const destLat = parseFloat(top.lat);
      const destLng = parseFloat(top.lon);

      // Calculate straight-line distance (Haversine)
      const R = 6371000; // metres
      const dLat = (destLat - coords.lat) * Math.PI / 180;
      const dLng = (destLng - coords.lng) * Math.PI / 180;
      const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(coords.lat * Math.PI / 180) * Math.cos(destLat * Math.PI / 180) *
        Math.sin(dLng / 2) ** 2;
      const dist = Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));

      const distText = dist < 1000 ? `${dist} metres` : `${(dist / 1000).toFixed(1)} km`;
      const name = top.display_name.split(',')[0];
      const reply = `🔍 The nearest ${name} is about ${distText} away.\n\nWould you like me to navigate there? Just say "Take me to ${name}".`;
      uiMsg(reply);
      speak(`The nearest ${name} is about ${distText} away. Say "Take me to ${name}" if you want directions.`);

    } catch (err) {
      log('Place search failed: ' + err.message);
      // graceful fallback — send to general chat for an AI text answer
      await _handleChat(msg);
    }
  }

  /* ─── GENERAL CHAT handler ─── */
  async function _handleChat(msg, pregenResponse = null) {
    log('→ GENERAL CHAT module');
    if (pregenResponse) {
      uiMsg(pregenResponse, 'ai');
      speak(pregenResponse);
      return;
    }
    if (typeof processGeneralChat === 'function') {
      await processGeneralChat(msg);
    } else if (typeof sendChat === 'function') {
      const input = document.getElementById('chatInput');
      if (input) input.value = msg;
      await sendChat();
    } else {
      const fallback = "I received your message but the chat module isn't ready yet.";
      uiMsg(fallback); speak(fallback);
    }
  }

  return { dispatch };
})();
