#include <WiFi.h>
#include <WebSocketsClient.h>
#include <driver/i2s.h>

// ===========================
// CONFIGURATION
const char* ssid = "Heisenberg";
const char* password = "11111111";

// Cloud Server Configuration
const char* serverIp = "visionai-hig1.onrender.com";
const int serverPort = 443;

// ===========================
unsigned long lastHeapLog = 0;
// I2S MIC PINS (INMP441)
// ===========================
#define I2S_WS 25
#define I2S_SCK 26
#define I2S_SD 33
#define I2S_PORT I2S_NUM_0

// ===========================
// EXTERNAL TOUCH BUTTON
// ===========================
#define TOUCH_PIN 13
#define LED_BUILTIN 2

// ===========================
// SPATIAL SENSORS
// ===========================
#define PIR_PIN 34        // HC-SR501 PIR Motion Sensor (Input-Only pin)
#define ULTRASONIC_TRIG 14 // HC-SR04 Trigger
#define ULTRASONIC_ECHO 35 // HC-SR04 Echo (Input-Only pin)
#define IR_PIN 32          // IR Obstacle Avoidance Sensor (Digital Out)

WebSocketsClient webSocket;
bool isRecording = false;
bool lastTouchState = LOW;
unsigned long lastSensorSend = 0;

// OPTIMIZED: Adaptive telemetry — fast when sensors detect proximity, slow when idle
const unsigned long ALERT_INTERVAL = 200;   // 200ms in HIGH ALERT mode
const unsigned long IDLE_INTERVAL  = 400;   // Reduced from 2000ms to 400ms to prevent stale follow-up reads
unsigned long currentSensorInterval = IDLE_INTERVAL;

// ===========================
// ULTRASONIC DISTANCE READER
// Median-of-5 + EMA smoothing
// ===========================
float emaDistance = -1;              // Exponential Moving Average state
const float EMA_ALPHA = 0.3;        // Smoothing factor (0.3 = responsive yet stable)

long singlePulseCM() {
  digitalWrite(ULTRASONIC_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(ULTRASONIC_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(ULTRASONIC_TRIG, LOW);

  // 35ms timeout (~6m). A longer timeout (like 100ms) blocks the ESP32 CPU and crashes the WiFi stack.
  unsigned long duration = pulseIn(ULTRASONIC_ECHO, HIGH, 35000); 
  if (duration == 0) return -1; // No echo
  
  long dist = (long)(duration * 0.034 / 2); // cm
  return dist;
}

// Circular buffer for median filter
const int SENSOR_WINDOW_SIZE = 5;
long distBuffer[SENSOR_WINDOW_SIZE] = {-1, -1, -1, -1, -1};
int distBufferIndex = 0;

// Sort helper for median computation
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

// Takes 1 sample per loop cycle, computes median of the trailing window.
// This prevents spamming the HC-SR04 (which requires 60ms between pings)
long readDistanceCM() {
  long d = singlePulseCM();
  
  // Debug to Serial Monitor so we can see raw pulses instantly
  Serial.printf("[SENSOR RAW] raw=%ldcm\n", d);

  // Update circular buffer with raw reading
  distBuffer[distBufferIndex] = d;
  distBufferIndex = (distBufferIndex + 1) % SENSOR_WINDOW_SIZE;

  // Extract valid readings for median calculation
  long validSamples[SENSOR_WINDOW_SIZE];
  int validCount = 0;
  
  for (int i = 0; i < SENSOR_WINDOW_SIZE; i++) {
    if (distBuffer[i] > 0 && distBuffer[i] <= 400) {
      validSamples[validCount++] = distBuffer[i];
    }
  }

  if (validCount == 0) {
    emaDistance = -1; // Reset EMA if no valid readings in the entire window
    return -1;       // Nothing in range
  }

  // Sort valid samples and pick the median
  sortArray(validSamples, validCount);
  long median = validSamples[validCount / 2];

  // Apply Exponential Moving Average for inter-cycle smoothing
  if (emaDistance < 0) {
    emaDistance = (float)median; // First valid reading — seed the EMA
  } else {
    emaDistance = EMA_ALPHA * median + (1.0 - EMA_ALPHA) * emaDistance;
  }

  return (long)(emaDistance + 0.5); // Round to nearest cm
}

void webSocketEvent(WStype_t type, uint8_t * payload, size_t length) {
  switch(type) {
    case WStype_DISCONNECTED:
      Serial.println("[WS] Disconnected from server!");
      break;
    case WStype_CONNECTED:
      Serial.printf("[WS] Connected to %s\n", payload);
      // Blink LED to indicate ready state
      for(int i=0; i<3; i++) {
        digitalWrite(LED_BUILTIN, HIGH); delay(100);
        digitalWrite(LED_BUILTIN, LOW); delay(100);
      }
      break;
    case WStype_TEXT:
      Serial.printf("[WS] Received msg: %s\n", payload);
      break;
  }
}

void setup() {
  Serial.begin(115200);
  Serial.println("Starting ESP32 Mic with WebSockets + Spatial Sensors...");

  // 1. CONNECT TO WIFI
  WiFi.mode(WIFI_STA);       
  WiFi.disconnect(true);     
  delay(100);                
  
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nWiFi Connected!");
  Serial.print("IP Address: ");
  Serial.println(WiFi.localIP());

  pinMode(LED_BUILTIN, OUTPUT);

  // 2. CONFIGURE I2S MIC
  i2s_config_t i2s_config = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
    .sample_rate = 16000,
    .bits_per_sample = I2S_BITS_PER_SAMPLE_32BIT,
    .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
    .communication_format = i2s_comm_format_t(I2S_COMM_FORMAT_I2S | I2S_COMM_FORMAT_I2S_MSB),
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
  pinMode(PIR_PIN, INPUT);          // Input-only pin, no pull needed
  pinMode(ULTRASONIC_TRIG, OUTPUT); // We fire the pulse
  pinMode(ULTRASONIC_ECHO, INPUT);  // Input-only pin, reads the bounce
  pinMode(IR_PIN, INPUT);           // Digital obstacle detection
  Serial.println("Spatial sensors initialized.");

  // 4. WS SERVER SETUP
  webSocket.beginSSL(serverIp, serverPort, "/api/pi/ws", "", "");
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(5000);
}

void loop() {
  webSocket.loop();
  
  if (WiFi.status() != WL_CONNECTED) {
    return;
  }

  // ─── PERIODIC HEAP LOGGING ───
  if (millis() - lastHeapLog >= 30000) {
    lastHeapLog = millis();
    Serial.printf("Free heap: %d bytes\n", ESP.getFreeHeap());
  }

  // ─── SENSOR TELEMETRY — OPTIMIZED: Adaptive frequency ───
  if (!isRecording && (millis() - lastSensorSend >= currentSensorInterval)) {
    lastSensorSend = millis();
    
    int pirState = digitalRead(PIR_PIN);       // 1 = motion detected
    long distanceCM = readDistanceCM();         // -1 = no object in range
    int irObstacle = !digitalRead(IR_PIN);      // IR sensor is active LOW, so we invert: 1 = obstacle close
    
    if (webSocket.isConnected()) {
      // OPTIMIZED: Adaptive polling — fast when danger detected, slow when clear
      bool isAlert = (distanceCM > 0 && distanceCM < 100) || pirState == 1 || irObstacle == 1;
      currentSensorInterval = isAlert ? ALERT_INTERVAL : IDLE_INTERVAL;
      const char* mode = isAlert ? "ALERT" : "IDLE";
      
      // OPTIMIZED: Compact key names (u, p, i) to reduce payload size
      char sensorJSON[128];
      snprintf(sensorJSON, sizeof(sensorJSON), "{\"type\":\"sensors\",\"u\":%ld,\"p\":%d,\"i\":%d,\"mode\":\"%s\"}", distanceCM, pirState, irObstacle, mode);
      
      webSocket.sendTXT(sensorJSON);
    }
  }

  // ─── PUSH-TO-TALK BUTTON HANDLING ───
  bool currentTouchState = digitalRead(TOUCH_PIN);
  
  if (currentTouchState == HIGH && lastTouchState == LOW) {
    if (webSocket.isConnected()) {
      Serial.println("\n[PTT] Interruption started! Beaming zero-latency signal...");
      digitalWrite(LED_BUILTIN, HIGH);
      
      webSocket.sendTXT("START");
      
      isRecording = true;
      i2s_zero_dma_buffer(I2S_PORT);
    } else {
      Serial.println("[ERR] WS not connected, cannot stream.");
    }
    delay(50);
  } 
  else if (currentTouchState == LOW && lastTouchState == HIGH && isRecording) {
    Serial.println("\n[PTT] Released! Finalizing buffer.");
    digitalWrite(LED_BUILTIN, LOW);
    
    webSocket.sendTXT("STOP");
    isRecording = false;
    
    uint32_t freeHeap = ESP.getFreeHeap();
    if (freeHeap < 20000) {
      Serial.println("[CRITICAL] Heap < 20KB. Self-restarting to fix fragmentation.");
      webSocket.sendTXT("{\"type\":\"ESP32_RESTARTING\"}");
      delay(100);
      webSocket.disconnect();
      delay(100);
      ESP.restart();
    } else if (freeHeap < 50000) {
      Serial.println("[WARNING] Heap < 50KB. Resetting WS connection to clear buffers.");
      webSocket.disconnect();
    }
    
    delay(50);
  }
  
  lastTouchState = currentTouchState;

  // ─── REAL-TIME AUDIO STREAMING ───
  if (isRecording) {
    uint8_t chunk32[2048];
    size_t bytesRead = 0;
    i2s_read(I2S_PORT, chunk32, 2048, &bytesRead, portMAX_DELAY);

    if (bytesRead > 0) {
      int samplesRead = bytesRead / 4; 
      int32_t* ptr32 = (int32_t*)chunk32;
      int16_t chunk16[512];
      
      // Noise gate threshold: values below this are silenced
      // Increase this if background noise is still too high
      const int NOISE_GATE_THRESHOLD = 200; 

      for(int i = 0; i < samplesRead; i++) {
        // Decrease gain: shifted by 15 instead of 14 cuts volume in half
        int32_t sample = ptr32[i] >> 15; 
        
        // Clamp to 16-bit range
        if (sample > 32767) sample = 32767;
        else if (sample < -32768) sample = -32768;
        
        int16_t sample16 = (int16_t)sample;
        
        // Apply software noise gate
        if (abs(sample16) < NOISE_GATE_THRESHOLD) {
            sample16 = 0;
        }

        chunk16[i] = sample16;
      }
      
      int bytesToSend = samplesRead * 2;
      webSocket.sendBIN((uint8_t*)chunk16, bytesToSend);
    }
  }
}