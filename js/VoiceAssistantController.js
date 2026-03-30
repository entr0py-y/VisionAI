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
    log("Capturing command via HARDWARE ESP32 Trigger...");

    if (isRecordingState) {
      log("Already waiting for hardware.");
      return;
    }

    isRecordingState = true;
    setMicUI(true); // Spin the mic UI while waiting for ESP32
    
    if (typeof addChatMessage === "function") {
      addChatMessage("ai", "📡 Contacting ESP32 Mic...");
    }

    // Ping Backend every 150ms until ESP32 physically starts I2S loop
    let listeningPoll = setInterval(async () => {
      if (!isRecordingState) {
        clearInterval(listeningPoll);
        return;
      }
      try {
        const ping = await fetch(getBackendUrl('/api/pi/listening-status'));
        const pingData = await ping.json();
        if (pingData.listening) {
          addChatMessage("system", "🟢 LISTENING NOW! Speak for 3 seconds...");
          clearInterval(listeningPoll);
        }
      } catch (e) {
        // silently fail polling
      }
    }, 150);

    try {
      // Tell the backend to command the ESP32 to record, and Wait for the reply!
      const response = await fetch(getBackendUrl('/api/pi/trigger-hardware-mic'), {
        method: 'POST'
      });

      isRecordingState = false;
      setMicUI(false);

      if (!response.ok) {
        log("Hardware routing timeout.");
        if (typeof addChatMessage === "function") {
          addChatMessage("ai", "Hardware Mic timed out or ESP32 is offline.");
        }
        return;
      }

      const data = await response.json();
      log(`Received hardware transcript: ${data.transcript}`);
      log(`Received AI Reply: ${data.text}`);

      // We have the User's transcript AND the AI's reply. 
      // Insert User's text into UI
      if (typeof addChatMessage === 'function') {
        addChatMessage("user", data.transcript);
      }
      
      // Instead of relying on backend's simple reply, route the transcribed audio to our smart Llama RouterEngine!
      if (typeof RouterEngine !== 'undefined' && typeof RouterEngine.dispatch === 'function') {
         RouterEngine.dispatch(data.transcript);
      } else {
         if (typeof addChatMessage === 'function') addChatMessage("ai", data.text);
      }

    } catch (err) {
      isRecordingState = false;
      setMicUI(false);
      log("Hardware fetch failed: " + err.message);
    }
  }

  return {
    start,
    stop,
    captureCommand,
    isRecording: () => isRecordingState
  };
})();
