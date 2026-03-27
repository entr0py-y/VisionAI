#!/usr/bin/env python3
"""
Vision AID — Raspberry Pi Client
=================================
Runs on the Raspberry Pi. Connects to your Vision AID web server
over the local WiFi network and enables:

  1. Voice input  → record audio → transcribe → send to /api/pi/audio-input
  2. Camera input → capture image → send to /api/pi/image-input
  3. Audio output → receive text response → speak aloud via espeak

Requirements (install on Pi):
  pip3 install requests SpeechRecognition pyaudio pillow openai-whisper
  sudo apt install espeak ffmpeg libportaudio2 -y

Usage:
  python3 pi_client.py
  python3 pi_client.py --server http://192.168.1.10:3000
  python3 pi_client.py --mode camera    # single camera shot
  python3 pi_client.py --mode voice     # single voice command
  python3 pi_client.py --mode loop      # continuous wake-word loop (default)
"""

import os
import sys
import base64
import argparse
import requests
import subprocess
import time
import io

# ─── Configuration ────────────────────────────────────────────────────────────
DEFAULT_SERVER = "http://192.168.1.10:3000"   # ← Change to your Mac's IP
WAKE_WORDS     = ["hey vision", "hey vission", "vision"]
MIC_TIMEOUT    = 5      # seconds to wait for speech before giving up
PHRASE_LIMIT   = 10     # max seconds per command
CAMERA_DEVICE  = 0      # /dev/video0 ; use 'pi' for PiCamera module
# ──────────────────────────────────────────────────────────────────────────────


def speak(text: str):
    """Speak text aloud via espeak (works offline on Pi)."""
    print(f"[TTS] {text}")
    try:
        subprocess.run(
            ["espeak", "-s", "140", "-v", "en", text],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except FileNotFoundError:
        # Fallback: try festival
        try:
            proc = subprocess.Popen(["festival", "--tts"], stdin=subprocess.PIPE)
            proc.communicate(input=text.encode())
        except FileNotFoundError:
            print("[TTS] espeak/festival not found — install with: sudo apt install espeak")


def send_text_to_server(server: str, text: str) -> dict:
    """Send a transcribed command to /api/pi/audio-input and get a response."""
    url = f"{server}/api/pi/audio-input"
    print(f"[PI→SERVER] Sending: '{text}'")
    try:
        resp = requests.post(url, json={"text": text}, timeout=15)
        resp.raise_for_status()
        data = resp.json()
        print(f"[SERVER→PI] Intent={data.get('intent')} Dest={data.get('destination')}")
        print(f"[SERVER→PI] Response: {data.get('response', '')[:120]}")
        return data
    except requests.exceptions.ConnectionError:
        speak("Cannot connect to the Vision AID server. Please check your network.")
        return {}
    except Exception as e:
        print(f"[ERROR] send_text_to_server: {e}")
        return {}


def send_image_to_server(server: str, image_bytes: bytes, mime: str = "image/jpeg", prompt: str = "") -> str:
    """Send a camera image to /api/pi/image-input and return the description."""
    url = f"{server}/api/pi/image-input"
    b64 = base64.b64encode(image_bytes).decode("utf-8")
    data_url = f"data:{mime};base64,{b64}"
    print(f"[PI→SERVER] Sending image ({len(image_bytes)//1024} KB) to {url}")
    try:
        resp = requests.post(url, json={"image": data_url, "prompt": prompt}, timeout=20)
        resp.raise_for_status()
        description = resp.json().get("description", "Could not analyse image.")
        print(f"[SERVER→PI] Vision: {description[:120]}")
        return description
    except requests.exceptions.ConnectionError:
        return "Cannot connect to the server."
    except Exception as e:
        print(f"[ERROR] send_image_to_server: {e}")
        return "Image analysis failed."


# ─── AUDIO: Speech Recognition ───────────────────────────────────────────────

def listen_for_speech(timeout=MIC_TIMEOUT, phrase_limit=PHRASE_LIMIT) -> str | None:
    """Record from the Pi microphone and return transcribed text, or None."""
    try:
        import speech_recognition as sr
    except ImportError:
        print("[ERROR] Install SpeechRecognition: pip3 install SpeechRecognition pyaudio")
        return None

    recognizer = sr.Recognizer()
    recognizer.energy_threshold = 300
    recognizer.dynamic_energy_threshold = True

    try:
        with sr.Microphone() as source:
            print("[MIC] Adjusting for ambient noise...")
            recognizer.adjust_for_ambient_noise(source, duration=0.5)
            print("[MIC] Listening...")
            audio = recognizer.listen(source, timeout=timeout, phrase_time_limit=phrase_limit)

        # Try Google (requires internet) first, then Sphinx offline
        try:
            text = recognizer.recognize_google(audio, language="en-US")
            print(f"[STT-Google] '{text}'")
            return text
        except Exception:
            pass

        # Whisper fallback (offline)
        try:
            import whisper
            import tempfile, wave
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
                f.write(audio.get_wav_data())
                tmp_path = f.name
            model = whisper.load_model("tiny")
            result = model.transcribe(tmp_path)
            os.unlink(tmp_path)
            text = result.get("text", "").strip()
            print(f"[STT-Whisper] '{text}'")
            return text if text else None
        except Exception:
            pass

        return None

    except sr.WaitTimeoutError:
        print("[MIC] No speech detected within timeout.")
        return None
    except Exception as e:
        print(f"[MIC] Error: {e}")
        return None


def contains_wake_word(text: str) -> bool:
    lower = text.lower()
    return any(w in lower for w in WAKE_WORDS)


def strip_wake_word(text: str) -> str:
    lower = text.lower()
    for w in WAKE_WORDS:
        idx = lower.find(w)
        if idx != -1:
            return text[idx + len(w):].strip(" ,.")
    return text


# ─── CAMERA: Image Capture ────────────────────────────────────────────────────

def capture_image_picamera() -> bytes | None:
    """Capture using PiCamera module (Pi Zero / Pi 3/4 with ribbon cable)."""
    try:
        # PiCamera2 (newer Pi OS)
        try:
            from picamera2 import Picamera2  # type: ignore
            cam = Picamera2()
            cam.start()
            time.sleep(0.5)
            buf = io.BytesIO()
            cam.capture_file(buf, format="jpeg")
            cam.stop()
            cam.close()
            return buf.getvalue()
        except ImportError:
            pass

        # Legacy picamera
        import picamera  # type: ignore
        buf = io.BytesIO()
        with picamera.PiCamera() as cam:
            cam.resolution = (1280, 720)
            time.sleep(0.5)
            cam.capture(buf, format="jpeg")
        return buf.getvalue()
    except Exception as e:
        print(f"[CAMERA-Pi] Error: {e}")
        return None


def capture_image_opencv() -> bytes | None:
    """Capture using OpenCV (works with USB webcam attached to Pi)."""
    try:
        import cv2
        cap = cv2.VideoCapture(CAMERA_DEVICE)
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
        time.sleep(0.3)
        ret, frame = cap.read()
        cap.release()
        if not ret:
            return None
        _, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
        return buf.tobytes()
    except Exception as e:
        print(f"[CAMERA-CV2] Error: {e}")
        return None


def capture_image() -> bytes | None:
    """Try PiCamera first, then OpenCV/USB webcam."""
    if CAMERA_DEVICE == "pi":
        return capture_image_picamera()
    img = capture_image_opencv()
    if img:
        return img
    return capture_image_picamera()


# ─── MODES ────────────────────────────────────────────────────────────────────

def mode_camera(server: str, prompt: str = ""):
    """Single shot: capture image → analyse → speak result."""
    speak("Capturing image. Please hold still.")
    img = capture_image()
    if not img:
        speak("Camera unavailable. Please check the camera connection.")
        return
    description = send_image_to_server(server, img, prompt=prompt)
    speak(description)


def mode_voice(server: str):
    """Single shot: listen → transcribe → send to server → speak response."""
    speak("Listening. Please speak your command.")
    text = listen_for_speech()
    if not text:
        speak("I didn't catch that. Please try again.")
        return
    data = send_text_to_server(server, text)
    response = data.get("response", "")
    intent   = data.get("intent", "GENERAL_CHAT")

    # If vision intent, also capture and send image
    if intent == "VISION":
        speak("Opening camera for visual analysis.")
        img = capture_image()
        if img:
            description = send_image_to_server(server, img, prompt=text)
            speak(description)
        else:
            speak(response or "Camera unavailable.")
    elif response:
        speak(response)


def mode_loop(server: str):
    """
    Continuous wake-word loop:
      Always listening → detect "Hey Vision" → capture command → route → respond
    """
    speak("Vision AID Pi client started. Say Hey Vision to begin.")
    print("\n[LOOP] Waiting for wake word... (Ctrl+C to quit)\n")

    while True:
        try:
            # Phase 1: wake word detection (short listen)
            waketext = listen_for_speech(timeout=10, phrase_limit=4)
            if not waketext:
                continue

            if not contains_wake_word(waketext):
                print(f"[LOOP] No wake word in: '{waketext}'")
                continue

            # Wake word detected
            print("[LOOP] 🎙️ Wake word detected!")
            speak("Yes?")

            # Phase 2: capture the actual command
            cmd_text = listen_for_speech(timeout=MIC_TIMEOUT, phrase_limit=PHRASE_LIMIT)

            # Check if command was appended to wake phrase in same utterance
            inline_cmd = strip_wake_word(waketext).strip()
            if inline_cmd and len(inline_cmd) > 3:
                cmd_text = inline_cmd
                print(f"[LOOP] Inline command: '{cmd_text}'")

            if not cmd_text or len(cmd_text.strip()) < 2:
                speak("I didn't catch your command. Please try again.")
                continue

            print(f"[LOOP] Command: '{cmd_text}'")

            # Send to server — it classifies and routes
            data = send_text_to_server(server, cmd_text)
            intent   = data.get("intent", "GENERAL_CHAT")
            response = data.get("response", "")

            if intent == "VISION":
                speak("Opening camera for visual analysis.")
                img = capture_image()
                if img:
                    description = send_image_to_server(server, img, prompt=cmd_text)
                    speak(description)
                else:
                    speak("Camera unavailable. Please check the connection.")
            elif response:
                speak(response)
            else:
                speak("Command received.")

        except KeyboardInterrupt:
            print("\n[LOOP] Stopped by user.")
            speak("Vision AID stopped. Goodbye.")
            break
        except Exception as e:
            print(f"[LOOP] Unexpected error: {e}")
            time.sleep(1)


# ─── Entry Point ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Vision AID Raspberry Pi Client")
    parser.add_argument("--server", default=os.environ.get("VISIONAID_SERVER", DEFAULT_SERVER),
                        help=f"Vision AID server URL (default: {DEFAULT_SERVER})")
    parser.add_argument("--mode", choices=["loop", "voice", "camera"], default="loop",
                        help="Operating mode (default: loop)")
    parser.add_argument("--prompt", default="", help="Optional prompt for camera mode")
    args = parser.parse_args()

    print(f"[PI] Vision AID Client")
    print(f"[PI] Server : {args.server}")
    print(f"[PI] Mode   : {args.mode}")
    print(f"[PI] Camera : {CAMERA_DEVICE}")
    print()

    # Quick connectivity check
    try:
        requests.get(args.server, timeout=3)
        print(f"[PI] ✅ Server reachable at {args.server}\n")
    except Exception:
        print(f"[PI] ⚠️  Cannot reach server at {args.server}")
        print(f"[PI]    Make sure your Mac and Pi are on the same WiFi")
        print(f"[PI]    and update DEFAULT_SERVER in this script.\n")

    if args.mode == "loop":
        mode_loop(args.server)
    elif args.mode == "voice":
        mode_voice(args.server)
    elif args.mode == "camera":
        mode_camera(args.server, prompt=args.prompt)
