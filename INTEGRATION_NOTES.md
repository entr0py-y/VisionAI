# Integration Notes — Vision AID Mobility Navigation Module

## Module Architecture

```
index.html (existing)
├── sendChat()     ──┐
│                    ├── AIIntentParser.processMessage(msg)
│                    │     ├── [match] → NavigationController.navigateTo(destination)
│                    │     │                ├── VoiceGuide.speak(...)
│                    │     │                ├── Geocode via Nominatim
│                    │     │                ├── openModal("mobility") [existing]
│                    │     │                ├── MobilityMap.init(container)
│                    │     │                ├── MobilityMap.setRoute(from, to)
│                    │     │                └── Turn-by-turn voice guidance
│                    │     └── [no match] → Normal AI backend flow
│                    │
├── openModal("mobility") → buildMobilityContent() → initMobility()
│                                                        └── MobilityMap.init()
├── closeModal()   → MobilityMap.destroy() + NavigationController.stopNavigation()
│
└── CDN Scripts: Leaflet 1.9.4, Leaflet Routing Machine 3.2.12
```

## How the Modules Connect

### 1. AIIntentParser.js → sendChat()

- **Intercept point**: Lines ~2988-2996 in `index.html`
- When the user types a message, `sendChat()` first calls `AIIntentParser.processMessage(msg)`
- If a navigation pattern is detected (e.g. "guide me to City Hospital"), the parser extracts the destination and calls `NavigationController.navigateTo()` directly
- Returns `true` to skip the AI backend call — the message is handled locally

### 2. NavigationController.js → MobilityMap.js + VoiceGuide.js

- `navigateTo(destination)` is the single entry point
- It sequentially: checks connectivity → gets GPS → geocodes via Nominatim → opens modal → inits map → plots route → starts voice guidance
- All errors produce spoken feedback via `VoiceGuide.announceError()`
- GPS fallback uses the same `get.geojs.io` IP API used by the dashboard widget

### 3. MobilityMap.js → Leaflet + Leaflet Routing Machine

- Creates a dark-themed Leaflet map (CartoDB Dark Matter tiles) inside `#mobilityMapContainer`
- User position tracked via `watchPosition` with IP fallback
- Routes calculated by Leaflet Routing Machine's OSRM backend
- Turn-by-turn instructions extracted from `routesfound` event and passed back to NavigationController
- ETA and distance values update the existing `#etaValue` and `#distValue` elements

### 4. VoiceGuide.js → Web Speech Synthesis API

- Thin wrapper matching the existing `speakText()` pattern
- Scoped to navigation: start, turns, approach, arrival, errors
- Cancels current speech before each new utterance

### 5. closeModal() cleanup

- `MobilityMap.destroy()` removes the Leaflet instance, clears GPS watch
- `NavigationController.stopNavigation()` stops voice guidance intervals

## Files Created

| File                         | Size       | Purpose                              |
| ---------------------------- | ---------- | ------------------------------------ |
| `js/VoiceGuide.js`           | ~75 lines  | Speech synthesis for navigation      |
| `js/MobilityMap.js`          | ~265 lines | Leaflet map, GPS tracking, routing   |
| `js/NavigationController.js` | ~235 lines | Orchestration: geocoding, map, voice |
| `js/AIIntentParser.js`       | ~80 lines  | Chat message intent detection        |

## Files Modified

| File         | Changes                                                                                                                                                                                                                                |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.html` | +CDN links in `<head>`, +map CSS, +`buildMobilityContent()` now renders `#mobilityMapContainer`, +`initMobility()` boots Leaflet, +`sendChat()` intercepts nav intent, +`closeModal()` cleans up map, +`<script>` tags for new modules |

## CDN Dependencies

- Leaflet 1.9.4: `unpkg.com/leaflet@1.9.4`
- Leaflet Routing Machine 3.2.12: `unpkg.com/leaflet-routing-machine@3.2.12`

## Navigation Trigger Patterns

The following phrases will trigger navigation (case-insensitive):

- "Guide me to [place]"
- "Navigate to [place]"
- "Take me to [place]"
- "Directions to [place]"
- "How do I get to [place]"
- "Walk me to [place]"
- "Show me the way to [place]"
- "Route to [place]"
- "Head to [place]"
- "Go to [place]"
- "I want to go to [place]"
- "I need to reach [place]"

Any other message passes through to the AI backend as normal.
