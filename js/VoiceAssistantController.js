const VoiceAssistantController = (() => {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  
  if (!SpeechRecognition) {
    console.error("Speech Recognition is not supported in this browser.");
    return {
      start: () => {},
      stop: () => {},
      captureCommand: () => {
        if (typeof addChatMessage === "function") {
          addChatMessage(
            "ai",
            "Voice input is not supported in this browser. Please use Chrome or Edge.",
          );
        }
      },
      isRecording: () => false,
    };
  }

  const recognition = new SpeechRecognition();
  recognition.continuous = false; // Only listen for one utterance
  recognition.interimResults = false;
  recognition.lang = "en-US";

  let isRecordingState = false;
  let shouldKeepListening = false;
  let gotFinalResult = false;
  let restartTimer = null;

  function log(msg) {
    console.log(`[VoiceAssistantController] ${msg}`);
  }

  function processUserInput(command) {
    log(`Command received: ${command}`);
    
    // UI input population
    const inp = document.getElementById('chatInput');
    if (inp && typeof sendChat === 'function') {
      inp.value = command;
      sendChat();
    } else if (typeof RouterEngine !== 'undefined') {
      RouterEngine.dispatch(command);
    }
  }

  function setMicUI(active) {
    const micBtn = document.getElementById('micBtn');
    if (micBtn) micBtn.classList.toggle('recording', active);
  }

  function startRecognitionSafely() {
    try {
      recognition.start();
      log("Recognition started.");
    } catch (error) {
      log("Error starting recognition: " + error.message);
    }
  }

  function clearRestartTimer() {
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
  }

  recognition.onresult = (event) => {
    let transcript = "";
    for (let i = event.resultIndex; i < event.results.length; ++i) {
      if (event.results[i].isFinal) {
        transcript += event.results[i][0].transcript;
      }
    }
    
    transcript = transcript.toLowerCase().trim();
    if (!transcript) return;

    log(`Captured raw string: ${transcript}`);
    gotFinalResult = true;
    shouldKeepListening = false;
    clearRestartTimer();
    processUserInput(transcript);
    
    // We already have what we need, clean up UI state
    stop();
  };

  recognition.onerror = (event) => {
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      log("Microphone permission denied.");
      shouldKeepListening = false;
      stop();
      return;
    }

    if (event.error === 'aborted') {
      return;
    }

    if (event.error === 'no-speech' || event.error === 'audio-capture' || event.error === 'network') {
      log("Recognition temporary issue: " + event.error);
      return;
    }

    if (!shouldKeepListening) {
      stop();
    } else {
      log("Recognition error: " + event.error);
    }
  };

  recognition.onend = () => {
    log("Recognition ended.");

    if (shouldKeepListening && !gotFinalResult) {
      clearRestartTimer();
      restartTimer = setTimeout(() => {
        if (shouldKeepListening && !gotFinalResult) {
          startRecognitionSafely();
        }
      }, 150);
      return;
    }

    isRecordingState = false;
    setMicUI(false);
  };

  function start() {
    // Kept for backward compatibility but does nothing if we don't want wake word
    log("Start called, but wake word is disabled.");
  }

  function stop() {
    clearRestartTimer();
    shouldKeepListening = false;
    gotFinalResult = false;
    isRecordingState = false;
    try {
      recognition.stop();
    } catch (e) {}

    setMicUI(false);
  }

  async function captureCommand() {
    log("Capturing command. Checking hardware ESP32...");

    if (isRecordingState) {
      log("Already waiting for hardware or listening locally.");
      return;
    }

    isRecordingState = true;
    setMicUI(true);

    try {
      // Check health endpoint to see if ESP32-MIC is actually online
      const healthCheck = await fetch(getBackendUrl('/api/pi/health')).catch(() => ({ ok: false }));
      let hwOnline = false;
      if (healthCheck && healthCheck.ok) {
        const hData = await healthCheck.json();
        hwOnline = hData.micOnline;
      }

      if (!hwOnline) {
        log("ESP32 Mic is offline. Falling back to built-in Web Speech API.");
        if (typeof addChatMessage === "function") {
          addChatMessage("ai", "🎙️ Hardware mic offline. Using built-in microphone...");
        }
        startRecognitionSafely();
        return; // Built-in handles the rest via onresult
      }

      // ESP32 is online, trigger it
      if (typeof addChatMessage === "function") {
        addChatMessage("ai", "📡 Contacting ESP32 Mic...");
      }

      let hasNotifiedListening = false;
      const pollListening = async () => {
        if (!isRecordingState || hasNotifiedListening) return;
        try {
          const ping = await fetch(getBackendUrl('/api/pi/listening-status'));
          const pingData = await ping.json();
          if (pingData.listening && !hasNotifiedListening) {
            hasNotifiedListening = true;
            addChatMessage("system", "🟢 LISTENING NOW! Speak for 3 seconds...");
            return;
          }
        } catch (e) {}
        if (!hasNotifiedListening) setTimeout(pollListening, 150);
      };
      pollListening();

      // Tell backend to trigger hardware
      const response = await fetch(getBackendUrl('/api/pi/trigger-hardware-mic'), { method: 'POST' });

      isRecordingState = false;
      setMicUI(false);

      if (!response.ok) {
        log("Hardware routing failed. Falling back to built-in Web Speech API.");
        if (typeof addChatMessage === "function") {
          addChatMessage("ai", "⚠️ Hardware timed out. Falling back to built-in microphone...");
        }
        startRecognitionSafely();
        return;
      }

      const data = await response.json();
      if (typeof addChatMessage === 'function') {
        addChatMessage("user", data.transcript);
      }
      
      if (typeof RouterEngine !== 'undefined' && typeof RouterEngine.dispatch === 'function') {
         RouterEngine.dispatch(data.transcript);
      } else {
         if (typeof addChatMessage === 'function') addChatMessage("ai", data.text);
      }

    } catch (err) {
      log("Hardware fetch failed: " + err.message + ". Falling back to Web Speech.");
      if (typeof addChatMessage === "function") {
        addChatMessage("ai", "⚠️ Connection error. Falling back to built-in microphone...");
      }
      startRecognitionSafely();
    }
  }

  return {
    start,
    stop,
    captureCommand,
    isRecording: () => isRecordingState
  };
})();
