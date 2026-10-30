#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <WebSocketsClient.h>
#include <driver/i2s.h>
#include <Preferences.h>
#include <WebServer.h>
#include <DNSServer.h>

// ===========================
// CONFIGURATION & PREFERENCES
// ===========================
Preferences preferences;
WebServer configServer(80);
DNSServer dnsServer;

String currentSSID = "";
String currentPass = "";
bool inConfigPortal = false;

// Default fallback credentials if none saved in NVS
const char* default_ssid = "Heisenberg69";
const char* default_password = "11111111";

// Android Local Device Hub Configuration (Phone Hotspot Gateway)
const char* serverIp = "192.168.43.1";
const int serverPort = 8888;

// ==============================================================================
// ESP32-S3 PIN DEFINITIONS
// (Pins 33-37 are reserved for internal Flash/PSRAM on ESP32-S3.
//  The pins below are 100% safe, high-speed GPIOs on ESP32-S3)
// ==============================================================================

// I2S MIC PINS (INMP441)
#define I2S_SCK   4    // I2S Bit Clock (BCLK)
#define I2S_WS    5    // I2S Word Select (LRCL)
#define I2S_SD    6    // I2S Serial Data (DIN)
#define I2S_PORT  I2S_NUM_0

// EXTERNAL BUTTON & LED
#define TOUCH_PIN  10   // Push-to-Talk button (internal pull-down)
#define LED_PIN    2    // Built-in LED on ESP32-S3 DevKit

// SPATIAL SENSORS (HC-SR04 & HC-SR501)
#define ULTRASONIC_TRIG  7    // HC-SR04 Trigger
#define ULTRASONIC_ECHO  8    // HC-SR04 Echo
#define PIR_PIN          9    // HC-SR501 PIR Motion Sensor   

WebSocketsClient webSocket;
bool wsConnected = false;
bool isRecording = false;

// Debouncing & auto-polarity variables
bool restingButtonState = LOW;
bool isButtonPressed = false;
bool lastButtonReading = LOW;
unsigned long lastDebounceTime = 0;
const unsigned long DEBOUNCE_DELAY = 50;

unsigned long lastSensorSend = 0;
unsigned long lastHeapLog = 0;
unsigned long lastWiFiCheck = 0;
unsigned long lastMicPing = 0;

// Global audio buffers to prevent heap fragmentation
#define AUDIO_BUFFER_SAMPLES 256
uint8_t pcm32Buffer[AUDIO_BUFFER_SAMPLES * 4]; 
int16_t pcm16Buffer[AUDIO_BUFFER_SAMPLES];

const unsigned long ALERT_INTERVAL = 200;   
const unsigned long IDLE_INTERVAL  = 400;   
unsigned long currentSensorInterval = IDLE_INTERVAL;

void ledOn() { digitalWrite(LED_PIN, HIGH); }
void ledOff() { digitalWrite(LED_PIN, LOW); }
void ledBlink(int times, int ms) {
  for (int i = 0; i < times; i++) {
    ledOn(); delay(ms);
    ledOff(); delay(ms);
  }
}

float emaDistance = -1;
const float EMA_ALPHA = 0.3;
const int SENSOR_WINDOW_SIZE = 5;
long distBuffer[SENSOR_WINDOW_SIZE] = {-1, -1, -1, -1, -1};
int distBufferIndex = 0;

long singlePulseCM() {
  digitalWrite(ULTRASONIC_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(ULTRASONIC_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(ULTRASONIC_TRIG, LOW);

  unsigned long duration = pulseIn(ULTRASONIC_ECHO, HIGH, 12000); 
  if (duration == 0) return -1;
  return (long)(duration * 0.034 / 2);
}

void sortArray(long arr[], int n) {
  for (int i = 1; i < n; i++) {
    long key = arr[i];
    int j = i - 1;
    while (j >= 0 && arr[j] > key) {
      arr[j + 1] = arr[j];
      j--;
    }
    arr[j + 1] = key;
  }
}

long readDistanceCM() {
  long d = singlePulseCM();
  distBuffer[distBufferIndex] = d;
  distBufferIndex = (distBufferIndex + 1) % SENSOR_WINDOW_SIZE;

  long validSamples[SENSOR_WINDOW_SIZE];
  int validCount = 0;
  for (int i = 0; i < SENSOR_WINDOW_SIZE; i++) {
    if (distBuffer[i] > 0 && distBuffer[i] <= 400) {
      validSamples[validCount++] = distBuffer[i];
    }
  }

  if (validCount == 0) return -1;

  sortArray(validSamples, validCount);
  long median = validSamples[validCount / 2];

  if (emaDistance < 0) {
    emaDistance = (float)median;
  } else {
    emaDistance = EMA_ALPHA * median + (1.0 - EMA_ALPHA) * emaDistance;
  }

  return (long)(emaDistance + 0.5);
}

void webSocketEvent(WStype_t type, uint8_t * payload, size_t length) {
  switch(type) {
    case WStype_DISCONNECTED:
      Serial.println("[WS] Disconnected from server!");
      wsConnected = false;
      break;
    case WStype_CONNECTED:
      Serial.printf("[WS] Connected to %s\n", payload);
      wsConnected = true;
      webSocket.sendTXT("{\"type\":\"ESP32_MIC\"}");
      ledBlink(3, 100);
      break;
    case WStype_TEXT:
      Serial.printf("[WS] Received msg: %s\n", payload);
      break;
    default:
      break;
  }
}

// ─── CAPTIVE PORTAL WEB SERVER ───
void handlePortalRoot() {
  int n = WiFi.scanNetworks();
  String options = "";
  for (int i = 0; i < n; ++i) {
    options += "<option value='" + WiFi.SSID(i) + "'>" + WiFi.SSID(i) + " (" + String(WiFi.RSSI(i)) + " dBm)</option>";
  }

  String html = "<!DOCTYPE html><html><head><meta name='viewport' content='width=device-width, initial-scale=1.0'>"
    "<title>VisionAID WiFi Setup</title>"
    "<style>"
    "body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;background:#0d1117;color:#c9d1d9;margin:0;padding:24px;display:flex;justify-content:center;align-items:center;min-height:100vh;box-sizing:border-box;}"
    ".card{background:#161b22;border:1px solid #30363d;border-radius:16px;padding:32px 24px;max-width:380px;width:100%;box-shadow:0 8px 24px rgba(0,0,0,0.5);}"
    "h2{margin-top:0;color:#58a6ff;font-size:22px;text-align:center;}"
    "p{font-size:14px;color:#8b949e;line-height:1.5;text-align:center;margin-bottom:24px;}"
    "label{font-size:13px;font-weight:600;display:block;margin-bottom:6px;color:#f0f6fc;}"
    "select,input[type=text],input[type=password]{width:100%;padding:12px;margin-bottom:18px;background:#0d1117;border:1px solid #30363d;border-radius:8px;color:#fff;font-size:15px;box-sizing:border-box;outline:none;}"
    "select:focus,input:focus{border-color:#58a6ff;}"
    "button{width:100%;padding:14px;background:#238636;color:#fff;border:none;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer;transition:0.2s;}"
    "button:active{background:#2ea043;transform:scale(0.98);}"
    ".badge{display:inline-block;background:#388bfd26;color:#58a6ff;padding:4px 10px;border-radius:20px;font-size:12px;margin-bottom:12px;}"
    "</style></head><body>"
    "<div class='card'>"
    "<div style='text-align:center;'><span class='badge'>VisionAID Mic & Sensor Module</span></div>"
    "<h2>WiFi Configuration</h2>"
    "<p>Select your home or mobile hotspot WiFi network and enter the password.</p>"
    "<form action='/save' method='POST'>"
    "<label>Select Available WiFi</label>"
    "<select onchange='document.getElementById(\"custom_ssid\").value = this.value;'>"
    "<option value=''>-- Select network --</option>" + options +
    "</select>"
    "<label>Or Type SSID</label>"
    "<input type='text' id='custom_ssid' name='ssid' placeholder='WiFi Network Name' required>"
    "<label>Password</label>"
    "<input type='password' name='pass' placeholder='WiFi Password'>"
    "<button type='submit'>Save & Connect</button>"
    "</form></div></body></html>";

  configServer.send(200, "text/html", html);
}

void handlePortalSave() {
  String newSSID = configServer.arg("ssid");
  String newPass = configServer.arg("pass");

  if (newSSID.length() > 0) {
    preferences.begin("wifi_cfg", false);
    preferences.putString("ssid", newSSID);
    preferences.putString("pass", newPass);
    preferences.end();

    String resp = "<!DOCTYPE html><html><body style='font-family:sans-serif;background:#0d1117;color:#fff;text-align:center;padding:40px;'>"
      "<h2 style='color:#3fb950;'>Credentials Saved!</h2>"
      "<p>ESP32 is now restarting to connect to: <b>" + newSSID + "</b></p>"
      "<p style='color:#8b949e;font-size:13px;'>You can now reconnect your phone to your normal Wi-Fi.</p>"
      "</body></html>";
    configServer.send(200, "text/html", resp);
    delay(2000);
    ESP.restart();
  } else {
    configServer.send(400, "text/plain", "SSID cannot be empty.");
  }
}

void startConfigPortal() {
  inConfigPortal = true;
  WiFi.mode(WIFI_AP);
  WiFi.softAP("VisionAID-Mic-Setup");
  IPAddress IP = WiFi.softAPIP();
  Serial.print("[AP] Hotspot active! SSID: VisionAID-Mic-Setup. IP: http://");
  Serial.println(IP);

  dnsServer.start(53, "*", IP);

  configServer.on("/", handlePortalRoot);
  configServer.on("/save", HTTP_POST, handlePortalSave);
  configServer.onNotFound([]() {
    configServer.sendHeader("Location", "/", true);
    configServer.send(302, "text/plain", "");
  });
  configServer.begin();
}

void setup() {
  Serial.begin(115200);
  Serial.println("\nStarting ESP32 Mic + Sensors...");

  pinMode(LED_PIN, OUTPUT);
  ledOff();

  // Load saved credentials from NVS Flash
  preferences.begin("wifi_cfg", false);
  currentSSID = preferences.getString("ssid", default_ssid);
  currentPass = preferences.getString("pass", default_password);
  preferences.end();

  Serial.printf("\n[WIFI] Attempting connection to SSID: %s\n", currentSSID.c_str());
  WiFi.mode(WIFI_STA);
  WiFi.begin(currentSSID.c_str(), currentPass.c_str());

  unsigned long startAttempt = millis();
  // Wait up to 60 seconds (60000ms)
  while (WiFi.status() != WL_CONNECTED && (millis() - startAttempt < 60000)) {
    delay(500);
    Serial.print(".");
    digitalWrite(LED_PIN, !digitalRead(LED_PIN)); // Fast blink while connecting
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\n[WIFI] Connected! IP: %s\n", WiFi.localIP().toString().c_str());
    ledBlink(3, 100);
    ledOff();
  } else {
    Serial.println("\n[WIFI] Could not connect in 60s! Launching Config Hotspot...");
    ledOn(); // Solid LED = Hotspot Config Mode
    startConfigPortal();
    return;
  }

  i2s_config_t i2s_config = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
    .sample_rate = 16000,
    .bits_per_sample = I2S_BITS_PER_SAMPLE_32BIT,
    .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
#if defined(I2S_COMM_FORMAT_STAND_I2S)
    .communication_format = I2S_COMM_FORMAT_STAND_I2S,
#else
    .communication_format = (i2s_comm_format_t)(I2S_COMM_FORMAT_I2S | I2S_COMM_FORMAT_I2S_MSB),
#endif
    .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
    .dma_buf_count = 16,
    .dma_buf_len = AUDIO_BUFFER_SAMPLES,
    .use_apll = false,
    .tx_desc_auto_clear = false,
    .fixed_mclk = 0
  };
  
  i2s_pin_config_t pin_config = {
    .bck_io_num = I2S_SCK,
    .ws_io_num = I2S_WS,
    .data_out_num = -1,
    .data_in_num = I2S_SD
  };
  
  i2s_driver_install(I2S_PORT, &i2s_config, 0, NULL);
  i2s_set_pin(I2S_PORT, &pin_config);
  i2s_zero_dma_buffer(I2S_PORT);

  // TTP223 Touch Module Input (Untouched = LOW, Touched = HIGH)
  pinMode(TOUCH_PIN, INPUT);

  pinMode(PIR_PIN, INPUT);          
  pinMode(ULTRASONIC_TRIG, OUTPUT);
  pinMode(ULTRASONIC_ECHO, INPUT); 

  // Connect directly to local Android Phone Hub (Dynamically discovers phone hotspot gateway)
  IPAddress targetHub = WiFi.gatewayIP();
  if (targetHub == IPAddress(0, 0, 0, 0)) {
    targetHub.fromString(serverIp);
  }
  Serial.printf("[WS] Connecting to Android Gateway: %s:%d\n", targetHub.toString().c_str(), serverPort);
  webSocket.begin(targetHub, serverPort, "/");
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(2000);
}

void loop() {
  if (inConfigPortal) {
    dnsServer.processNextRequest();
    configServer.handleClient();
    return;
  }

  webSocket.loop();

  // WiFi Reconnection Logic
  if (WiFi.status() != WL_CONNECTED) {
    if (millis() - lastWiFiCheck >= 5000) {
      Serial.println("[WIFI] Disconnected. Reconnecting...");
      WiFi.disconnect();
      WiFi.reconnect();
      lastWiFiCheck = millis();
    }
    return;
  }

  // Periodic 3s Heartbeat Ping to keep "micOnline" solidly green in app
  if (wsConnected && (millis() - lastMicPing >= 3000)) {
    webSocket.sendTXT("{\"type\":\"MIC_PING\"}");
    lastMicPing = millis();
  }

  // Periodic memory log
  if (millis() - lastHeapLog > 30000) {
    lastHeapLog = millis();
    Serial.printf("[MEM] Free heap: %u bytes\n", ESP.getFreeHeap());
  }
  
  // Guard against recording while disconnected
  if (isRecording && !wsConnected) {
    isRecording = false;
    ledOff();
    Serial.println("[PTT] WS disconnected! Stopping recording.");
  }

  // ─── SENSOR TELEMETRY ───
  if (!isRecording && (millis() - lastSensorSend >= currentSensorInterval)) {
    lastSensorSend = millis();
    int pirState = digitalRead(PIR_PIN);       
    long distanceCM = readDistanceCM();         
    
    if (wsConnected) {
      bool isAlert = (pirState == 1) || (distanceCM > 0 && distanceCM < 100);
      currentSensorInterval = isAlert ? ALERT_INTERVAL : IDLE_INTERVAL;
      const char* mode = isAlert ? "ALERT" : "IDLE";
      
      char sensorJSON[128];
      snprintf(sensorJSON, sizeof(sensorJSON), "{\"type\":\"sensors\",\"p\":%d,\"u\":%ld,\"mode\":\"%s\"}", 
               pirState, distanceCM, mode);
      webSocket.sendTXT(sensorJSON);
    }
  }

  // ─── TTP223 TOUCH SENSOR LOGIC ───
  bool rawReading = (digitalRead(TOUCH_PIN) == HIGH);

  if (rawReading != isButtonPressed) {
    if ((millis() - lastDebounceTime) > 30) {
      isButtonPressed = rawReading;
      lastDebounceTime = millis();
      
      if (isButtonPressed) {
        // TOUCH DETECTED
        Serial.println("[PTT] TTP223 TOUCH DETECTED! Sending START...");
        ledOn();
        if (wsConnected) {
          webSocket.sendTXT("START");
          isRecording = true;
          i2s_zero_dma_buffer(I2S_PORT);
        } else {
          Serial.println("[ERR] WS not connected, cannot stream.");
        }
      } else {
        // TOUCH RELEASED
        Serial.println("[PTT] TTP223 RELEASED! Sending STOP...");
        ledOff();
        if (isRecording) {
          webSocket.sendTXT("STOP");
          isRecording = false;
        }
      }
    }
  }

  // ─── REAL-TIME AUDIO STREAMING ───
  if (isRecording) {
    static int32_t dcOffset = 0;
    static int32_t peakLevel = 1000;  // AGC peak tracker

    size_t bytesRead = 0;
    esp_err_t result = i2s_read(I2S_PORT, pcm32Buffer, sizeof(pcm32Buffer), &bytesRead, 100 / portTICK_PERIOD_MS);

    if (result == ESP_OK && bytesRead > 0) {
      int samplesRead = bytesRead / 4;
      int32_t* ptr32 = (int32_t*)pcm32Buffer;
      const int NOISE_GATE_THRESHOLD = 50;
      int32_t maxSample = 0;

      for (int i = 0; i < samplesRead; i++) {
        // Correct bit-shift: INMP441 is 24-bit left-justified in 32-bit
        int32_t sample = ptr32[i] >> 14;

        // High-pass DC offset removal
        dcOffset += (sample - dcOffset) / 256;
        sample -= dcOffset;

        // Track peak for AGC
        int32_t absSample = abs(sample);
        if (absSample > maxSample) maxSample = absSample;

        // Apply AGC gain
        int32_t gain = 16000 / max(peakLevel, (int32_t)1);
        if (gain < 1) gain = 1;
        if (gain > 20) gain = 20;
        sample = sample * gain;

        // Clamp to 16-bit range
        if (sample > 32767) sample = 32767;
        else if (sample < -32768) sample = -32768;

        int16_t sample16 = (int16_t)sample;

        // Noise gate (reduced threshold)
        if (abs(sample16) < NOISE_GATE_THRESHOLD) {
          sample16 = 0;
        }
        pcm16Buffer[i] = sample16;
      }

      // Update AGC peak with exponential decay
      if (maxSample > peakLevel) {
        peakLevel = maxSample;  // Fast attack
      } else {
        peakLevel = peakLevel - (peakLevel / 500);  // Slow decay
        if (peakLevel < 500) peakLevel = 500;  // Floor to prevent division issues
      }

      int bytesToSend = samplesRead * 2;
      webSocket.sendBIN((uint8_t*)pcm16Buffer, bytesToSend);
    }
  }
}