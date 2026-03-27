/**
 * MobilityMap.js — Vision AID Leaflet Map Component
 *
 * Renders an accessible, high-contrast Leaflet map inside the Mobility modal.
 * Handles user location tracking, destination markers, and route polylines.
 * Uses Leaflet Routing Machine for route calculation and turn-by-turn data.
 *
 * Integration: Called by NavigationController when navigation is triggered.
 * The map container is injected into the existing Mobility modal's #mobilityMapContainer div.
 */

const MobilityMap = (() => {
  let map = null;
  let userMarker = null;
  let destMarker = null;
  let routingControl = null;
  let watchId = null;
  let userCoords = null;
  let onInstructionsReady = null; // callback for turn-by-turn data

  // Large, high-contrast custom icons for accessibility (40x40px minimum)
  function createUserIcon() {
    return L.divIcon({
      className: 'mobility-user-icon',
      html: `<div style="
        width:44px;height:44px;border-radius:50%;
        background:rgba(66,133,244,0.9);
        border:4px solid #fff;
        box-shadow:0 0 16px rgba(66,133,244,0.6), 0 2px 8px rgba(0,0,0,0.4);
        display:flex;align-items:center;justify-content:center;
      "><div style="width:12px;height:12px;border-radius:50%;background:#fff;"></div></div>`,
      iconSize: [44, 44],
      iconAnchor: [22, 22],
    });
  }

  function createDestIcon() {
    return L.divIcon({
      className: 'mobility-dest-icon',
      html: `<div style="
        width:44px;height:52px;display:flex;flex-direction:column;align-items:center;
      "><div style="
        width:44px;height:44px;border-radius:50%;
        background:rgba(234,67,53,0.9);
        border:4px solid #fff;
        box-shadow:0 0 16px rgba(234,67,53,0.6), 0 2px 8px rgba(0,0,0,0.4);
        display:flex;align-items:center;justify-content:center;
        font-size:20px;
      ">📍</div></div>`,
      iconSize: [44, 52],
      iconAnchor: [22, 52],
    });
  }

  /**
   * Initialize the Leaflet map in the given container element ID.
   * @param {string} containerId - The DOM element ID to render the map in.
   */
  function init(containerId) {
    const container = document.getElementById(containerId);
    if (!container) {
      console.error('MobilityMap: Container not found:', containerId);
      return;
    }

    // Destroy any previous instance
    destroy();

    // Create the map with dark tiles for accessibility
    map = L.map(containerId, {
      zoomControl: true,
      attributionControl: false,
    }).setView([28.6139, 77.2090], 14); // Default center (will be overridden by GPS)

    // High-contrast dark map tiles (CartoDB Dark Matter)
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 19,
      subdomains: 'abcd',
    }).addTo(map);

    // Start watching user position
    startTracking();

    // Force a map resize after the modal animation completes
    setTimeout(() => {
      if (map) map.invalidateSize();
    }, 400);
  }

  /**
   * Start GPS tracking via watchPosition.
   */
  function startTracking() {
    if (!('geolocation' in navigator)) {
      VoiceGuide.announceError('no-location');
      return;
    }

    let initResolved = false;
    const fbTimer = setTimeout(() => {
      if (!initResolved) {
        initResolved = true;
        ipFallbackLocation();
      }
    }, 10000);

    // Try to get initial position immediately
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (!initResolved) {
          initResolved = true;
          clearTimeout(fbTimer);
          updateUserPosition(pos.coords.latitude, pos.coords.longitude);
        }
      },
      (err) => {
        if (!initResolved) {
          initResolved = true;
          clearTimeout(fbTimer);
          console.warn('MobilityMap: Initial position failed, trying IP fallback');
          ipFallbackLocation();
        }
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );

    // Continuous tracking
    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        updateUserPosition(pos.coords.latitude, pos.coords.longitude);
      },
      (err) => {
        console.warn('MobilityMap: watchPosition error', err.message);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 2000 }
    );
  }

  /**
   * IP-based fallback for user location (same API used by the dashboard widget).
   */
  async function ipFallbackLocation() {
    try {
      const res = await fetch('https://get.geojs.io/v1/ip/geo.json');
      const data = await res.json();
      if (data.latitude && data.longitude) {
        updateUserPosition(parseFloat(data.latitude), parseFloat(data.longitude));
      }
    } catch (e) {
      console.error('MobilityMap: IP fallback also failed');
    }
  }

  /**
   * Update the user's marker position on the map.
   */
  function updateUserPosition(lat, lng) {
    userCoords = { lat, lng };

    if (!map) return;

    if (userMarker) {
      userMarker.setLatLng([lat, lng]);
    } else {
      userMarker = L.marker([lat, lng], { icon: createUserIcon() }).addTo(map);
      userMarker.bindPopup('You are here').openPopup();
      map.setView([lat, lng], 15);
    }
  }

  /**
   * Get the current user coordinates.
   * @returns {{ lat: number, lng: number } | null}
   */
  function getUserCoords() {
    return userCoords;
  }

  /**
   * Set and display a route from the user's position to a destination.
   * @param {{ lat: number, lng: number }} from - Start coordinates
   * @param {{ lat: number, lng: number }} to - Destination coordinates
   * @param {string} destName - Human-readable destination name
   * @param {function} onInstructions - Callback with turn-by-turn instructions array
   */
  function setRoute(from, to, destName, onInstructions) {
    if (!map) return;

    onInstructionsReady = onInstructions;

    // Remove old routing control if exists
    if (routingControl) {
      map.removeControl(routingControl);
      routingControl = null;
    }

    // Remove old destination marker
    if (destMarker) {
      map.removeLayer(destMarker);
      destMarker = null;
    }

    // Add destination marker
    destMarker = L.marker([to.lat, to.lng], { icon: createDestIcon() }).addTo(map);
    destMarker.bindPopup(destName || 'Destination').openPopup();

    // Fit map to show both points
    const bounds = L.latLngBounds([
      [from.lat, from.lng],
      [to.lat, to.lng],
    ]);
    map.fitBounds(bounds, { padding: [50, 50] });

    // Create route using Leaflet Routing Machine
    routingControl = L.Routing.control({
      waypoints: [
        L.latLng(from.lat, from.lng),
        L.latLng(to.lat, to.lng),
      ],
      routeWhileDragging: false,
      addWaypoints: false,
      draggableWaypoints: false,
      fitSelectedRoutes: true,
      showAlternatives: false,
      createMarker: () => null, // We handle markers ourselves
      lineOptions: {
        styles: [
          { color: '#4285F4', opacity: 0.9, weight: 6 },
          { color: '#ffffff', opacity: 0.3, weight: 10 },
        ],
        extendToWaypoints: true,
        missingRouteTolerance: 10,
      },
      show: false, // Hide the default instruction panel
    }).addTo(map);

    // Listen for route found event to extract turn-by-turn instructions
    routingControl.on('routesfound', (e) => {
      const route = e.routes[0];
      if (!route) return;

      const summary = route.summary;
      const instructions = route.instructions || [];

      // Update ETA and distance in the modal if elements exist
      const etaEl = document.getElementById('etaValue');
      const distEl = document.getElementById('distValue');
      if (etaEl) etaEl.textContent = Math.round(summary.totalTime / 60);
      if (distEl) distEl.textContent = (summary.totalDistance / 1000).toFixed(1);

      // Extract human-readable turn-by-turn instructions
      const turnInstructions = instructions.map((inst) => {
        return inst.text || '';
      }).filter(Boolean);

      if (onInstructionsReady) {
        onInstructionsReady(turnInstructions, destName);
      }
    });

    routingControl.on('routingerror', (e) => {
      console.error('MobilityMap: Routing error', e);
      if (onInstructionsReady) {
        onInstructionsReady(null, destName);
      }
    });
  }

  /**
   * Destroy the map instance and clean up resources.
   */
  function destroy() {
    if (watchId !== null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }
    if (routingControl && map) {
      try { map.removeControl(routingControl); } catch (e) {}
      routingControl = null;
    }
    if (map) {
      map.remove();
      map = null;
    }
    userMarker = null;
    destMarker = null;
    userCoords = null;
    onInstructionsReady = null;
  }

  /**
   * Check if the map is currently initialized.
   */
  function isActive() {
    return map !== null;
  }

  return {
    init,
    destroy,
    getUserCoords,
    setRoute,
    updateUserPosition,
    isActive,
  };
})();
