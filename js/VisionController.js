/**
 * VisionController.js — Vision AID Camera & Image Analysis Module
 *
 * Responsibilities:
 *  - Trigger ESP32-CAM via Long-Polling
 *  - Return a descriptive, accessibility-optimised response
 *  - Speak the result aloud
 */

const VisionController = (() => {
  let stream = null;
  let videoEl = null;

  function wantsDeviceCamera(prompt) {
    const text = String(prompt || '').toLowerCase();
    return /(?:use|switch to|open|start|activate|force|use the|use device|device camera|inbuilt camera|built[-\s]?in camera|laptop camera|webcam|browser camera)\b/.test(text)
      && /(?:device camera|inbuilt camera|built[-\s]?in camera|webcam|browser camera|camera input)/.test(text);
  }

  async function stopStream() {
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
    }
    if (videoEl) {
      videoEl.srcObject = null;
      videoEl.remove();
      videoEl = null;
    }
  }

  async function captureDeviceCameraFrame() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Device camera is not available in this browser');
    }

    await stopStream();
    stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });

    videoEl = document.createElement('video');
    videoEl.autoplay = true;
    videoEl.playsInline = true;
    videoEl.muted = true;
    videoEl.style.position = 'fixed';
    videoEl.style.left = '-9999px';
    videoEl.style.top = '-9999px';
    videoEl.srcObject = stream;

    document.body.appendChild(videoEl);

    await new Promise((resolve) => {
      if (videoEl.readyState >= 2) return resolve();
      videoEl.onloadedmetadata = () => resolve();
    });

    await videoEl.play();

    const width = videoEl.videoWidth || 1280;
    const height = videoEl.videoHeight || 720;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Unable to access canvas context for camera capture');

    ctx.drawImage(videoEl, 0, 0, width, height);
    const image = canvas.toDataURL('image/jpeg', 0.92);

    await stopStream();
    return image;
  }

  /* ─── Internal helpers ─── */

  function log(msg) { console.log('[VisionController]', msg); }

  function uiMsg(text, type = 'ai') {
    if (typeof addChatMessage === 'function') addChatMessage(type, text);
  }

  function speak(text) {
    if (typeof speakText === 'function') speakText(text);
  }

  /* ─── Main public method ─── */

  /**
   * Analyse the scene and speak the result using hardware ESP32-CAM.
   * @param {string} [userPrompt] — optional extra instruction, e.g. "focus on text"
   */
  async function analyseScene(userPrompt) {
    const useDeviceCamera = wantsDeviceCamera(userPrompt);

    try {
       if (useDeviceCamera) {
         uiMsg('📷 Using the device inbuilt camera only...', 'ai');
         speak('Using the device camera only. Please allow camera access and hold still.');

         const image = await captureDeviceCameraFrame();
         const resp = await fetch(getBackendUrl('/api/vision'), {
           method: 'POST',
           headers: { 'Content-Type': 'application/json' },
           body: JSON.stringify({
             image,
             prompt: userPrompt || '',
             source: 'browser',
             username: localStorage.getItem('visionAidUsername') || 'unknown',
           }),
         });
         if (!resp.ok) throw new Error('Device camera analysis failed');
         const data = await resp.json();
         const description = data.description || 'I could not analyse the device camera image.';
         uiMsg('👁️ ' + description, 'ai');
         speak(description);

         if (typeof conversationHistory !== 'undefined') {
           conversationHistory.push({ role: 'model', text: description });
           if (typeof saveMemory === 'function') saveMemory();
         }
         return description;
       }

       uiMsg('📸 Triggering ESP32 Camera to analyse your surroundings...', 'ai');
       speak('Triggering ESP32 camera. Please point it forward and hold still.');

       console.log('Routing directly to ESP32 Hardware Camera...');

      const espRes = await fetch(getBackendUrl('/api/pi/trigger-hardware-camera'), {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ prompt: userPrompt || '' }),
       });
       if (!espRes.ok) throw new Error('ESP Camera timeout or error');
       const espData = await espRes.json();

       const description = espData.description || 'I could not analyse the ESP image.';
       uiMsg('👁️ ' + description, 'ai');
       speak(description);
       
       // Persist to conversation history if available
       if (typeof conversationHistory !== 'undefined') {
         conversationHistory.push({ role: 'model', text: description });
         if (typeof saveMemory === 'function') saveMemory();
       }
       return description;
    } catch(espErr) {
       log('Hardware camera fetch failed: ' + espErr.message);
       const fallback = useDeviceCamera
         ? 'Device camera unavailable or permission denied. Please allow camera access and try again.'
         : 'Hardware camera offline or timed out. Please check your ESP32-CAM connection.';
       uiMsg('⚠️ ' + fallback, 'ai');
       speak(fallback);
       return null;
    }
  }

  /**
   * Process a raw base64 image sent from the ESP directly (Alternative endpoint)
   * @param {string} base64Image
   * @param {string} [prompt]
   */
  async function analyseFromPi(base64Image, prompt) {
    try {
      const resp = await fetch(getBackendUrl('/api/vision'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: base64Image, prompt: prompt || '', source: 'pi', username: localStorage.getItem("visionAidUsername") || "unknown" }),
      });
      const data = await resp.json();
      const description = data.description || 'Could not analyse hardware image.';
      uiMsg('👁️ ' + description, 'ai');
      speak(description);
      return description;
    } catch (err) {
      log('Hardware vision processing error: ' + err.message);
      return null;
    }
  }

  return { analyseScene, analyseFromPi, captureFrame: captureDeviceCameraFrame };
})();
