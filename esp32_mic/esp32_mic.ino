#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <WebSocketsClient.h>
#include <driver/i2s.h>

// ===========================
// CONFIGURATION
// ===========================
const char* ssid = "Heisenberg";
const char* password = "11111111";

// Cloud Server Configuration
const char* serverIp = "visionaid-5ut9.onrender.com";
const int serverPort = 443;

// ═══════════════════════════════════════════════════════════════════════════════
// ESP32 DEV MODULE (WROOM-32 / DevKit) PIN MAPPING
// ═══════════════════════════════════════════════════════════════════════════════
//
//  ┌────────────────────────────────────────────────────────┐
//  │             ESP32 Dev Module (WROOM-32)                │
//  │                                                        │
//  │  3V3  ─── VCC for INMP441, HC-SR501, Push Button       │
//  │  VIN  ─── 5V VCC for HC-SR04                           │
//  │  GND  ─── GND for all modules                          │
//  │                                                        │
//  │  GPIO 26 ─── I2S_SCK  (INMP441 BCLK / SCK)             │
//  │  GPIO 25 ─── I2S_WS   (INMP441 LRCLK / WS)             │
//  │  GPIO 33 ─── I2S_SD   (INMP441 DOUT / SD)              │
//  │                                                        │
//  │  GPIO 18 ─── TOUCH_PIN (Push-to-Talk button)           │
//  │  GPIO 19 ─── PIR_PIN   (HC-SR501 Motion OUT)           │
//  │  GPIO 5  ─── TRIG_PIN  (HC-SR04 Trigger)               │
//  │  GPIO 17 ─── ECHO_PIN  (HC-SR04 Echo via 5V->3.3V div) │
//  │                                                        │
//  │  GPIO 2  ─── On-board Blue LED                         │
//  └────────────────────────────────────────────────────────┘
//
// ═══════════════════════════════════════════════════════════════════════════════
// WIRING GUIDE
// ═══════════════════════════════════════════════════════════════════════════════
//
//  INMP441 Microphone (I2S):
//    VDD  → 3.3V
//    GND  → GND
//    L/R  → GND (Left channel)
//    SCK  → GPIO 26
//    WS   → GPIO 25
//    SD   → GPIO 33
//
//  Push-To-Talk Button:
//    Signal → GPIO 18 (Using internal pulldown or push button to 3.3V)
//
//  HC-SR501 PIR Sensor:
//    VCC  → 5V (VIN) or 3.3V
//    GND  → GND
//    OUT  → GPIO 19
//
//  HC-SR04 Ultrasonic Sensor:
//    VCC  → 5V (VIN)
//    GND  → GND
//    TRIG → GPIO 5
//    ECHO → 1kΩ resistor → GPIO 17 → 2kΩ resistor → GND (voltage divider)
//
// ═══════════════════════════════════════════════════════════════════════════════

// ===========================
// I2S MIC PINS (INMP441) — ESP32 Dev Module
// ===========================
#define I2S_SCK   26   // Bit clock (BCLK)
#define I2S_WS    25   // Word select (LRCLK)
#define I2S_SD    33   // Serial data in (DOUT on INMP441)
#define I2S_PORT  I2S_NUM_0

// ===========================
// EXTERNAL BUTTON & LED
// ===========================
#define TOUCH_PIN  18  // Push-to-Talk Button
#define LED_PIN    2   // On-board Blue LED for ESP32 Dev Module

// ===========================
// SPATIAL SENSORS
// ===========================
#define PIR_PIN          19   // HC-SR501 PIR Motion Sensor
#define ULTRASONIC_TRIG  5    // HC-SR04 Trigger
#define ULTRASONIC_ECHO  17   // HC-SR04 Echo (5V to 3.3V divider)

WebSocketsClient webSocket;
bool isRecording = false;
bool lastTouchState = LOW;
unsigned long lastSensorSend = 0;
unsigned long lastHeapLog = 0;

// Heap allocation for audio buffers
uint8_t* pcm32Buffer = nullptr; 
int16_t* pcm16Buffer = nullptr;

// Adaptive telemetry
const unsigned long ALERT_INTERVAL = 200;   // 200ms in HIGH ALERT mode
const unsigned long IDLE_INTERVAL  = 400;   // 400ms in IDLE mode
unsigned long currentSensorInterval = IDLE_INTERVAL;

// ===========================
// LED HELPERS (Standard GPIO 2)
// ===========================
void ledOn() {
  digitalWrite(LED_PIN, HIGH);
}

void ledOff() {
  digitalWrite(LED_PIN, LOW);
}

void ledBlink(int times, int ms) {
  for (int i = 0; i < times; i++) {
    ledOn(); delay(ms);
    ledOff(); delay(ms);
  }
}

// ===========================
// ULTRASONIC DISTANCE READER
// Median-of-5 + EMA smoothing
// ===========================
float emaDistance = -1;
const float EMA_ALPHA = 0.3;

long singlePulseCM() {
  digitalWrite(ULTRASONIC_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(ULTRASONIC_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(ULTRASONIC_TRIG, LOW);

  unsigned long duration = pulseIn(ULTRASONIC_ECHO, HIGH, 12000); 
  if (duration == 0) return -1;
  
  long dist = (long)(duration * 0.034 / 2);
  return dist;
}

// Circular buffer for median filter
const int SENSOR_WINDOW_SIZE = 5;
long distBuffer[SENSOR_WINDOW_SIZE] = {-1, -1, -1, -1, -1};
int distBufferIndex = 0;

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

  if (validCount == 0) {
    emaDistance = -1;
    return -1;
  }

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
      break;
    case WStype_CONNECTED:
      Serial.printf("[WS] Connected to %s\n", payload);
      ledBlink(3, 100);
      break;
    case WStype_TEXT:
      Serial.printf("[WS] Received msg: %s\n", payload);
      break;
  }
}

void setup() {
  Serial.begin(115200);
  Serial.println("\n==================================================");
  Serial.println("Starting ESP32 Dev Module Mic + Spatial Sensors...");
  Serial.printf("[SYS] Chip: %s  Rev: %d  Cores: %d\n", 
                ESP.getChipModel(), ESP.getChipRevision(), ESP.getChipCores());
  Serial.printf("[SYS] Free Heap: %u bytes\n", ESP.getFreeHeap());
  Serial.println("==================================================");

  // 1. CONNECT TO WIFI
  WiFi.mode(WIFI_STA);       
  WiFi.disconnect(true);     
  delay(100);                
  
  Serial.println("\n[WIFI] Scanning for available networks...");
  int n = WiFi.scanNetworks();
  if (n == 0) {
    Serial.println("[WIFI] No networks found at all! Check antenna or hotspot 2.4GHz setting.");
  } else {
    Serial.printf("[WIFI] %d networks found:\n", n);
    bool foundHotspot = false;
    for (int i = 0; i < n; ++i) {
      Serial.printf("  %d: %s (RSSI: %d, Ch: %d)\n", i + 1, WiFi.SSID(i).c_str(), WiFi.RSSI(i), WiFi.channel(i));
      if (WiFi.SSID(i) == ssid) {
        foundHotspot = true;
      }
      delay(10);
    }
    if (foundHotspot) {
      Serial.printf("[WIFI] Your hotspot '%s' is VISIBLE. Attempting to connect...\n", ssid);
    } else {
      Serial.printf("[WIFI] Your hotspot '%s' is NOT VISIBLE to the ESP32. It might be on 5GHz or out of range.\n", ssid);
    }
  }
  
  WiFi.begin(ssid, password);
  int connectAttempts = 0;
  while (WiFi.status() != WL_CONNECTED && connectAttempts < 20) {
    delay(500);
    Serial.print(".");
    connectAttempts++;
  }
  
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("\n[WIFI] Failed to connect after 10 seconds! Check password or 2.4GHz hotspot.");
  } else {
    Serial.println("\n[WIFI] Connected!");
    Serial.print("[WIFI] IP Address: ");
    Serial.println(WiFi.localIP());
  }

  // LED Setup
  pinMode(LED_PIN, OUTPUT);
  ledOff();

  // 2. CONFIGURE I2S MIC (ESP32 Dev Module WROOM)
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
    .dma_buf_len = 1024,
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
  
  esp_err_t err = i2s_driver_install(I2S_PORT, &i2s_config, 0, NULL);
  if (err != ESP_OK) {
    Serial.printf("I2S driver install failed: 0x%x\n", err);
  }
  i2s_set_pin(I2S_PORT, &pin_config);
  i2s_zero_dma_buffer(I2S_PORT);
  Serial.println("I2S Mic initialized.");

  // 3. CONFIGURE SENSOR PINS
  pinMode(TOUCH_PIN, INPUT_PULLDOWN);
  pinMode(PIR_PIN, INPUT);          
  pinMode(ULTRASONIC_TRIG, OUTPUT);
  pinMode(ULTRASONIC_ECHO, INPUT); 
  Serial.println("Sensors initialized.");

  // 4. WS SERVER SETUP
  webSocket.beginSSL(serverIp, serverPort, "/api/pi/ws");
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(5000);
  Serial.println("[WS] WebSocket client started.");
}

void loop() {
  webSocket.loop();

  // Periodic heap log (30s)
  if (millis() - lastHeapLog > 30000) {
    lastHeapLog = millis();
    Serial.printf("[MEM] Free heap: %u bytes\n", ESP.getFreeHeap());
  }
  
  if (WiFi.status() != WL_CONNECTED) {
    return;
  }

  // ─── SENSOR TELEMETRY — Adaptive frequency ───
  if (!isRecording && (millis() - lastSensorSend >= currentSensorInterval)) {
    lastSensorSend = millis();
    
    int pirState = digitalRead(PIR_PIN);       
    long distanceCM = readDistanceCM();         
    
    if (webSocket.isConnected()) {
      bool isAlert = (pirState == 1) || (distanceCM > 0 && distanceCM < 100);
      currentSensorInterval = isAlert ? ALERT_INTERVAL : IDLE_INTERVAL;
      const char* mode = isAlert ? "ALERT" : "IDLE";
      
      char sensorJSON[150];
      snprintf(sensorJSON, sizeof(sensorJSON), "{\"type\":\"sensors\",\"p\":%d,\"u\":%ld,\"mode\":\"%s\"}", 
               pirState, distanceCM, mode);
      
      webSocket.sendTXT(sensorJSON);
    }
  }

  // ─── PUSH-TO-TALK BUTTON HANDLING ───
  bool currentTouchState = digitalRead(TOUCH_PIN);
  
  // Button pressed (LOW→HIGH transition)
  if (currentTouchState == HIGH && lastTouchState == LOW) {
    if (webSocket.isConnected()) {
      Serial.println("\n[PTT] Button pressed! Starting recording...");
      ledOn();
      
      webSocket.sendTXT("START");
      
      // Allocate audio buffers in SRAM (or PSRAM if board supports it)
      if (psramFound() && ESP.getFreePsram() > 4096) {
        pcm32Buffer = (uint8_t*)ps_malloc(2048);
        pcm16Buffer = (int16_t*)ps_malloc(1024);
        Serial.println("[MEM] Audio buffers allocated in PSRAM");
      } else {
        pcm32Buffer = (uint8_t*)malloc(2048);
        pcm16Buffer = (int16_t*)malloc(1024);
        Serial.println("[MEM] Audio buffers allocated in SRAM");
      }
      
      isRecording = true;
      i2s_zero_dma_buffer(I2S_PORT);
    } else {
      Serial.println("[ERR] WS not connected, cannot stream.");
    }
    delay(50);
  } 
  // Button released (HIGH→LOW transition)
  else if (currentTouchState == LOW && lastTouchState == HIGH && isRecording) {
    Serial.println("\n[PTT] Released! Finalizing buffer.");
    ledOff();
    
    webSocket.sendTXT("STOP");
    
    // Free audio buffers
    if (pcm32Buffer) { free(pcm32Buffer); pcm32Buffer = nullptr; }
    if (pcm16Buffer) { free(pcm16Buffer); pcm16Buffer = nullptr; }
    
    isRecording = false;
    
    uint32_t freeHeap = ESP.getFreeHeap();
    Serial.printf("[MEM] Final heap after session: %u bytes\n", freeHeap);
    
    if (freeHeap < 20000) {
      Serial.println("[MEM] Critical Heap Low! Self-healing restart...");
      webSocket.sendTXT("{\"type\":\"ESP32_RESTARTING\"}");
      delay(500);
      ESP.restart();
    } else if (freeHeap < 50000) {
      Serial.println("[MEM] Warning: Heap low, clearing internal WebSocket buffers...");
      webSocket.disconnect();
    }
    
    delay(50);
  }
  
  lastTouchState = currentTouchState;

  // ─── REAL-TIME AUDIO STREAMING ───
  if (isRecording && pcm32Buffer && pcm16Buffer) {
    size_t bytesRead = 0;
    i2s_read(I2S_PORT, pcm32Buffer, 2048, &bytesRead, portMAX_DELAY);

    if (bytesRead > 0) {
      int samplesRead = bytesRead / 4; 
      int32_t* ptr32 = (int32_t*)pcm32Buffer;
      
      const int NOISE_GATE_THRESHOLD = 200; 

      for(int i = 0; i < samplesRead; i++) {
        int32_t sample = ptr32[i] >> 15; 
        
        if (sample > 32767) sample = 32767;
        else if (sample < -32768) sample = -32768;
        
        int16_t sample16 = (int16_t)sample;
        
        if (abs(sample16) < NOISE_GATE_THRESHOLD) {
            sample16 = 0;
        }

        pcm16Buffer[i] = sample16;
      }
      
      int bytesToSend = samplesRead * 2;
      webSocket.sendBIN((uint8_t*)pcm16Buffer, bytesToSend);
    }
  }
}