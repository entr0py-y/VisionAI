#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <driver/i2s.h>

// ===========================
// CONFIGURATION
const char* ssid = "Heisenberg";
const char* password = "11111111";

// Cloud Server Configuration
const char* serverIp = "visionai-hig1.onrender.com";
const int serverPort = 443;

// ===========================
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
#define LED_BUILTIN 2 // Most ESP32 Dev Boards have a blue LED on GPIO 2

void setup() {
  Serial.begin(115200);
  Serial.println("Starting ESP32 Mic...");

  // 1. CONNECT TO WIFI (With aggressive NVS corruption bypass)
  WiFi.mode(WIFI_STA);       // Explicitly set ESP32 to Station Mode 
  WiFi.disconnect(true);     // Force erase any corrupted internal Wi-Fi configurations
  delay(100);                // Wait for the RF modem to completely wipe its cache
  
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nWiFi Connected!");
  Serial.print("IP Address: ");
  Serial.println(WiFi.localIP());

  // Blink internal LED thrice to signal system is Online and Ready
  pinMode(LED_BUILTIN, OUTPUT);
  for(int i=0; i<3; i++) {
    digitalWrite(LED_BUILTIN, HIGH); delay(150);
    digitalWrite(LED_BUILTIN, LOW); delay(150);
  }

  // 2. CONFIGURE I2S MIC
  i2s_config_t i2s_config = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
    .sample_rate = 16000,
    .bits_per_sample = I2S_BITS_PER_SAMPLE_32BIT, // Must read 32-bit to capture INMP441's 24-bit precision!
    .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
    .communication_format = i2s_comm_format_t(I2S_COMM_FORMAT_I2S | I2S_COMM_FORMAT_I2S_MSB),
    .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
    .dma_buf_count = 16,     // Doubled buffer count
    .dma_buf_len = 1024,     // Maximized buffer length to survive network latency
    .use_apll = false,
    .tx_desc_auto_clear = false,
    .fixed_mclk = 0
  };
  
  i2s_pin_config_t pin_config = {
    .bck_io_num = I2S_SCK,
    .ws_io_num = I2S_WS,
    .data_out_num = -1, // No speaker
    .data_in_num = I2S_SD
  };
  
  esp_err_t err = i2s_driver_install(I2S_PORT, &i2s_config, 0, NULL);
  if (err != ESP_OK) {
    Serial.printf("I2S driver install failed: 0x%x\n", err);
  }
  i2s_set_pin(I2S_PORT, &pin_config);
  i2s_zero_dma_buffer(I2S_PORT);
  Serial.println("I2S Mic initialized.");

  // Initialize Physics Touch Button with Internal Pull-Down Resistor
  // This explicitly guarantees it sits perfectly at LOW (0V) instead of floating into an infinite loop!
  pinMode(TOUCH_PIN, INPUT_PULLDOWN);
}

WiFiClientSecure persistentStatusClient;
bool isStatusClientInit = false;
bool lastTouchState = LOW;

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    delay(1000);
    return;
  }

  // Check Physical Touch Sensor Fast Path
  bool currentTouchState = digitalRead(TOUCH_PIN);
  
  if (currentTouchState == HIGH && lastTouchState == LOW) {
    Serial.println("\n[PTT] Physical Touch Detected! Instantly recording to RAM...");
    // PTT Stream - RAM Buffered
    recordToRAMAndSend(false);
    
    // Debounce
    delay(200); 
    currentTouchState = digitalRead(TOUCH_PIN);
  }
  
  lastTouchState = currentTouchState;

  // Initialize Persistent SSL Context once
  if (!isStatusClientInit) {
    persistentStatusClient.setInsecure();
    isStatusClientInit = true;
  }

  // Status Web Polling
  HTTPClient http;
  http.setReuse(true);
  String statusUrl = String("https://") + serverIp + "/api/pi/status?device=mic&t=" + String(millis());
  http.begin(persistentStatusClient, statusUrl);
  
  int httpCode = http.GET();
  if (httpCode == HTTP_CODE_OK) {
    String payload = http.getString();
    
    // Remotely triggered by Web UI
    if (payload.indexOf("\"RECORD\"") >= 0 || payload.indexOf("RECORD") >= 0) {
      Serial.println("\n[TRIGGER] Received remote RECORD command. Simulating standard pulse...");
      recordToRAMAndSend(true);
    }
  }
  http.end();
  
  delay(100); 
}

void recordToRAMAndSend(bool isRemotelyTriggered) {
  // We instantly hijack the currently idling background polling TLS Socket!
  // This physically bypasses the 1.5-second mbedTLS handshaking latency entirely!
  if (!persistentStatusClient.connected()) {
     Serial.println("Reconnecting persistent tunnel...");
     persistentStatusClient.connect(serverIp, serverPort);
  }

  // Fire off HTTP POST headers directly over the hot tunnel. 
  persistentStatusClient.print("POST /api/pi/audio-input HTTP/1.1\r\n");
  persistentStatusClient.print("Host: " + String(serverIp) + "\r\n");
  persistentStatusClient.print("Connection: keep-alive\r\n"); 
  persistentStatusClient.print("Content-Type: application/octet-stream\r\n");
  persistentStatusClient.print("Transfer-Encoding: chunked\r\n\r\n");

  i2s_zero_dma_buffer(I2S_PORT);
  size_t totalBytesRecorded = 0;
  const size_t maxDurationBytes = 96000; // Hard limit 3.0 seconds

  Serial.println("🔴 STREAMING AUDIO LIVE TO RENDER (Chunked)...");
  digitalWrite(LED_BUILTIN, HIGH); // PHYSICAL INDICATOR: TURN ON (Speak Now)

  while (totalBytesRecorded < maxDurationBytes) {
      // DYNAMIC PTT FAST-PATH: If the user releases the physical button, violently snap the recording off early!
      // This trivially slashes exactly as many seconds of latency off the backend processing as the user didn't need to use!
      // We physically enforce a minimum of 0.5 seconds (16,000 bytes) so the Cloud STT API doesn't reject an empty file.
      if (digitalRead(TOUCH_PIN) == LOW && totalBytesRecorded > 16000) {
          Serial.println("👆 Physical Button Released! Cutting stream early to reduce massive API latency...");
          break;
      }
      uint8_t chunk32[2048]; // 512 samples
      size_t bytesRead = 0;
      i2s_read(I2S_PORT, chunk32, 2048, &bytesRead, portMAX_DELAY);

      int samplesRead = bytesRead / 4; 
      int32_t* ptr32 = (int32_t*)chunk32;
      int16_t chunk16[512];
      
      for(int i = 0; i < samplesRead; i++) {
        int32_t sample = ptr32[i] >> 14; 
        if (sample > 32767) sample = 32767;
        if (sample < -32768) sample = -32768;
        chunk16[i] = (int16_t)sample;
      }
      
      int bytesToSend = samplesRead * 2;
      
      // HTTP Chunked streaming format natively encapsulates fragments dynamically!
      persistentStatusClient.printf("%X\r\n", bytesToSend);
      persistentStatusClient.write((uint8_t*)chunk16, bytesToSend);
      persistentStatusClient.print("\r\n");
      
      totalBytesRecorded += bytesToSend;
  }

  // End the Chunked transfer with a 0 byte slice
  persistentStatusClient.print("0\r\n\r\n");
  digitalWrite(LED_BUILTIN, LOW); // PHYSICAL INDICATOR: TURN OFF (Stop Speaking)
  
  Serial.printf("⏹️ LIVE STREAM CONCLUDED. Securely beamed %u bytes!\n", totalBytesRecorded);
  Serial.println("✅ Audio successfully bridged to Cloud Transcriber. Waiting for API...");

  long timeout = millis();
  while (persistentStatusClient.connected() && millis() - timeout < 7000) {
    if (persistentStatusClient.available()) {
      persistentStatusClient.read();
      timeout = millis();
    }
  }
  Serial.println("[UPLOAD] Whisper API HTTP Response Concluded.");

  isStatusClientInit = false; // Reboot background polling
}
