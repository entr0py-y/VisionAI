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
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false
    });

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

    // Give the camera sensor time to adjust exposure and white balance
    // Otherwise the first frame is almost always completely black
    await new Promise(r => setTimeout(r, 1500));

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

  function uiMsg(text, type = 'ai', imageUrl = null) {
    if (typeof addChatMessage === 'function') return addChatMessage(type, text, null, imageUrl);
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
         return await runDeviceCamera(userPrompt);
       }

       // Check if ESP32-CAM is online via local connection state
       const hwOnline = window.espCamOnline || false;

       if (!hwOnline) {
         log("ESP32-CAM is offline. Falling back to device camera.");
         uiMsg('⚠️ Hardware camera offline. Falling back to device camera...', 'ai');
         return await runDeviceCamera(userPrompt);
       }

       uiMsg('📸 Capturing from ESP32 Camera...', 'ai');
       speak('Capturing from ESP32 camera. Please hold still.');

       console.log('Fetching image from local ESP32-CAM...');

       // Capture JPEG directly from local ESP32-CAM HTTP server
       const ESP32_CAM_URL = "http://192.168.4.2";
       const captureResp = await fetch(`${ESP32_CAM_URL}/capture`);
       if (!captureResp.ok) {
         const errText = await captureResp.text().catch(() => '');
         throw new Error(errText || 'ESP Camera capture failed');
       }
       
       const imageBlob = await captureResp.blob();
       
       // Convert blob to base64 for display and API call
       const base64Image = await new Promise((resolve, reject) => {
         const reader = new FileReader();
         reader.onloadend = () => resolve(reader.result);
         reader.onerror = reject;
         reader.readAsDataURL(imageBlob);
       });

       // Send to Render backend for AI vision analysis
       const resp = await fetch(getBackendUrl('/api/vision'), {
         method: 'POST',
         headers: { 
           'Content-Type': 'application/json',
           'x-ai-keys': localStorage.getItem('aiApiKeys') || ''
         },
         body: JSON.stringify({
           image: base64Image,
           prompt: userPrompt || '',
           source: 'esp32',
           username: localStorage.getItem('visionAidUsername') || 'unknown',
         }),
       });

       if (!resp.ok) throw new Error('Vision analysis failed');
       const data = await resp.json();

       const description = data.description || 'I could not analyse the ESP image.';
       const capturedImage = data.image || base64Image || null;
       uiMsg('👁️ ' + description, 'ai', capturedImage);
       speak(description);
       
       // Persist to conversation history if available
       if (typeof conversationHistory !== 'undefined') {
         conversationHistory.push({ role: 'model', text: description });
         if (typeof saveMemory === 'function') saveMemory();
       }
       return description;
    } catch(espErr) {
       log('Hardware camera fetch failed: ' + espErr.message);
       if (!useDeviceCamera) {
          log("Hardware camera failed. Falling back to device camera: " + espErr.message);
          uiMsg(`⚠️ Hardware camera: ${espErr.message}. Falling back to device camera...`, 'ai');
          return await runDeviceCamera(userPrompt);
       } else {
          const fallback = 'Device camera unavailable or permission denied. Please allow camera access and try again.';
          uiMsg('⚠️ ' + fallback, 'ai');
          speak(fallback);
          return null;
       }
    }
  }

  async function runDeviceCamera(userPrompt) {
    try {
      uiMsg('📷 Using the device inbuilt camera...', 'ai');
      speak('Using the device camera. Please allow camera access and hold still.');

      const image = await captureDeviceCameraFrame();
      const resp = await fetch(getBackendUrl('/api/vision'), {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'x-ai-keys': localStorage.getItem('aiApiKeys') || ''
        },
        body: JSON.stringify({
          image,
          prompt: userPrompt || '',
          source: 'browser',
          username: localStorage.getItem('visionAidUsername') || 'unknown',
        }),
      });
      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}));
        throw new Error(errData.description || errData.error || 'Device camera analysis failed');
      }
      const data = await resp.json();
      const description = data.description || 'I could not analyse the device camera image.';
      const capturedImage = data.image || image || null;
      uiMsg('👁️ ' + description, 'ai', capturedImage);
      speak(description);

      if (typeof conversationHistory !== 'undefined') {
        conversationHistory.push({ role: 'model', text: description });
        if (typeof saveMemory === 'function') saveMemory();
      }
      return description;
    } catch(err) {
      log('Device camera fetch failed: ' + err.message);
      const fallback = 'Device camera unavailable or permission denied. Please allow camera access and try again.';
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
      const capturedImage = data.image || base64Image || null;
      uiMsg('👁️ ' + description, 'ai', capturedImage);
      speak(description);
      return description;
    } catch (err) {
      log('Hardware vision processing error: ' + err.message);
      return null;
    }
  }

  return { analyseScene, analyseFromPi, captureFrame: captureDeviceCameraFrame };
})();
