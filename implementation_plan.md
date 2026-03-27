# Implementation Plan — Vision AID Mobility Navigation Module

## 1. Codebase Audit Summary

### Architecture

- **Single-file app**: All UI, CSS, and JS live in `index.html` (~3317 lines)
- **Backend**: `server.js` (Express, NVIDIA LLaMA 3.3 70B via OpenAI-compatible API)
- **No bundler**: Static files served by Express. All additions must use CDN imports or inline code.

### Key Integration Points Found

| Component                  | Location               | How It Works                                                                           |
| -------------------------- | ---------------------- | -------------------------------------------------------------------------------------- |
| Mobility module definition | `index.html:1992-2010` | `modules[]` array entry with `id: "mobility"`                                          |
| Mobility card click        | `index.html:2080`      | `card.onclick = () => openModal(m.id)` calls `openModal("mobility")`                   |
| `openModal("mobility")`    | `index.html:2105-2136` | Builds modal, calls `buildMobilityContent()`, then `initModalInteractions("mobility")` |
| `buildMobilityContent()`   | `index.html:2178-2209` | Returns HTML with fake map placeholder, crowd meter, ETA/distance cards                |
| `initMobility()`           | `index.html:2898-2914` | Randomizes crowd/ETA/distance values on interval                                       |
| `sendChat()`               | `index.html:2976-3057` | Main chat handler — intercept point for navigation intent                              |
| `speakText()`              | `index.html:2452-2468` | TTS utility using Web Speech Synthesis API                                             |
| `addChatMessage()`         | `index.html:2771-2780` | Adds message bubble to chat container                                                  |
| Modal overlay/panel        | `index.html:1942-1950` | `#modalOverlay`, `#modalPanel`, `#modalBody`                                           |
| `closeModal()`             | `index.html:2138-2144` | Clears intervals, hides modal                                                          |

### Existing TTS

The app already has `speakText(text)` using `SpeechSynthesisUtterance`. The new `VoiceGuide` module will reuse this pattern.

---

## 2. Files to Create

Since this is a no-bundler single-file app, new modules are added as **separate JS files** loaded via `<script>` tags. This avoids modifying the monolith and keeps things modular.

| File                         | Purpose                                               |
| ---------------------------- | ----------------------------------------------------- |
| `js/VoiceGuide.js`           | Speech synthesis utility for navigation announcements |
| `js/NavigationController.js` | Geocoding, route management, map lifecycle            |
| `js/AIIntentParser.js`       | Intercepts chat messages, detects navigation intent   |
| `js/MobilityMap.js`          | Leaflet map component, user tracking, route polyline  |

### Files to Modify

| File         | Change                                                                                                                                                                                                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.html` | (1) Add Leaflet CSS/JS CDN links in `<head>` (2) Add `<script>` tags for new JS modules before `</body>` (3) Add Leaflet Routing Machine CDN (4) Add minimal CSS for the map container (5) Modify `buildMobilityContent()` to include a map `<div>` (6) Add navigation-intent intercept in `sendChat()` |

---

## 3. Component Hierarchy

```
sendChat() (existing)
  └── AIIntentParser.checkIntent(message)
        ├── [match] → NavigationController.navigateTo(destination)
        │                 ├── VoiceGuide.speak("Opening navigation...")
        │                 ├── Geocode destination via Nominatim
        │                 ├── openModal("mobility")  [existing]
        │                 ├── MobilityMap.init(mapContainerId)
        │                 ├── MobilityMap.setRoute(userCoords, destCoords)
        │                 └── VoiceGuide.speak(turn-by-turn)
        └── [no match] → pass through to AI backend (existing flow)
```

---

## 4. Third-Party Libraries

| Library                 | Version | CDN                                        | Purpose                          |
| ----------------------- | ------- | ------------------------------------------ | -------------------------------- |
| Leaflet                 | 1.9.4   | `unpkg.com/leaflet@1.9.4`                  | Map rendering                    |
| Leaflet Routing Machine | 3.2.12  | `unpkg.com/leaflet-routing-machine@3.2.12` | Route calculation + turn-by-turn |

Both load via CDN `<link>` / `<script>` tags. No npm install needed.

---

## 5. Implementation Steps

### Step 1: VoiceGuide.js

- Thin wrapper around `window.speechSynthesis`
- `speak(text)` — cancels current speech, speaks new text
- `stop()` — cancels all speech

### Step 2: MobilityMap.js

- `init(containerId)` — creates Leaflet map in the given div
- `setUserLocation(lat, lng)` — places/moves the large user marker
- `setRoute(fromCoords, toCoords, destName)` — uses LRM to draw route, parse instructions
- `destroy()` — cleanup map instance and GPS watch
- Uses `navigator.geolocation.watchPosition` for real-time tracking
- Large 40×40px markers for accessibility
- Dark/high-contrast tile layer

### Step 3: NavigationController.js

- `navigateTo(destinationText)` — orchestrates the full flow
- Geocodes via Nominatim
- Acquires user location
- Opens mobility modal
- Initializes MobilityMap
- Starts voice guidance
- Handles all error states with spoken feedback

### Step 4: AIIntentParser.js

- `checkIntent(message)` — returns `{ isNavigation: bool, destination: string }`
- Regex patterns: "guide me to", "navigate to", "take me to", "directions to", "how do I get to"
- Extracts destination from the captured group

### Step 5: Integration into index.html

- Add CDN links in `<head>`
- Add `<script src="js/...">` before `</body>`
- Modify `buildMobilityContent()` to include `<div id="mobilityMap">`
- Modify `sendChat()` to call `AIIntentParser.checkIntent()` before AI backend
- Modify `initMobility()` to initialize the live map

---

## 6. Test Plan

| Test                                        | Expected Result                                                                                            |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Click Mobility card                         | Modal opens with live Leaflet map showing user location                                                    |
| Type "Guide me to City Hospital" in AI chat | Intent detected → modal opens → map loads → route drawn → voice says "Opening navigation to City Hospital" |
| Type "Hello" in AI chat                     | No intent detected → message sent to AI backend normally                                                   |
| GPS denied                                  | Voice says "Location access is required for navigation"                                                    |
| Invalid destination typed                   | Voice says "Sorry, I couldn't find that location"                                                          |
| Offline                                     | Voice says "No internet connection. Navigation is unavailable."                                            |
| Route progress                              | Turn-by-turn instructions spoken aloud                                                                     |
| Close modal                                 | Map destroyed, GPS watch cleared, intervals cleared                                                        |

---

## 7. Accessibility Checklist

- [x] Markers ≥ 40×40px
- [x] High-contrast dark map tiles
- [x] All status changes announced via voice
- [x] No interaction requires reading the screen
- [x] Touch-operable map controls
