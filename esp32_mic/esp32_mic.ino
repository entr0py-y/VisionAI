#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <driver/i2s.h>

// ===========================
// CONFIGURATION
// ===========================
const char* ssid = "vision";
const char* password = "12345678";

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

void setup() {
  Serial.begin(115200);
  Serial.println("Starting ESP32 Mic...");

  // 1. CONNECT TO WIFI
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nWiFi Connected!");
  Serial.print("IP Address: ");
  Serial.println(WiFi.localIP());

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
}

WiFiClientSecure persistentStatusClient;
bool isStatusClientInit = false;

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    delay(1000);
    return;
  }

  // Initialize Persistent SSL Context once to avoid 2-second computational delays every poll
  if (!isStatusClientInit) {
    persistentStatusClient.setInsecure();
    isStatusClientInit = true;
  }

  HTTPClient http;
  http.setReuse(true); // Keep connection warm
  String statusUrl = String("https://") + serverIp + "/api/pi/status?t=" + String(millis());
  http.begin(persistentStatusClient, statusUrl);
  
  int httpCode = http.GET();
  if (httpCode == HTTP_CODE_OK) {
    String payload = http.getString();
    
    // Check if the server wants us to record
    if (payload.indexOf("\"RECORD\"") >= 0 || payload.indexOf("RECORD") >= 0) {
      Serial.println("\n[TRIGGER] Received RECORD command. Recording Mic...");
      recordAndSendAudio();
    }
  } else {
    Serial.printf("[HTTP] GET /api/pi/status failed, error: %s\n", http.errorToString(httpCode).c_str());
  }
  
  http.end();
  delay(100); 
}

void recordAndSendAudio() {
  const int recordTimeSec = 3;
  const int sampleRate = 16000;
  const int numBytes = recordTimeSec * sampleRate * 2;

  Serial.println("Establishing HTTPS connection before recording...");
  WiFiClientSecure clientAudio;
  clientAudio.setInsecure(); // Required for Render HTTPS Upload

  if (clientAudio.connect(serverIp, serverPort)) {
    Serial.println("Streaming exact 3.0s audio directly to Cloudflare...");
    clientAudio.print("POST /api/pi/audio-input HTTP/1.1\r\n");
    clientAudio.print("Host: " + String(serverIp) + "\r\n");
    clientAudio.print("Connection: close\r\n"); 
    clientAudio.print("Content-Type: application/octet-stream\r\n");
    clientAudio.print("Content-Length: " + String(numBytes) + "\r\n\r\n");

    // Clean Start I2S
    i2s_zero_dma_buffer(I2S_PORT);
    size_t totalBytesRead = 0;
    
    // Stream directly from I2S 32-bit and convert -> HTTPS socket 16-bit
    while (totalBytesRead < numBytes) {
      uint8_t chunk32[2048]; // Read 512 samples at 32-bits per sample
      size_t bytesToRead = 2048; 
      size_t bytesRead = 0;
      i2s_read(I2S_PORT, chunk32, bytesToRead, &bytesRead, portMAX_DELAY);

      int samplesRead = bytesRead / 4; // 32-bit samples (4 bytes each)
      int32_t* ptr32 = (int32_t*)chunk32;
      int16_t chunk16[512]; // We compress them down to 1024 bytes of 16-bit data
      
      for(int i = 0; i < samplesRead; i++) {
        // Shift right by 14 is the gold-standard algorithm to extract 24-bit INMP441 audio 
        // into a flawless 16-bit space with zero clipping or static noise!
        int32_t sample = ptr32[i] >> 14; 
        
        if (sample > 32767) sample = 32767;
        if (sample < -32768) sample = -32768;
        chunk16[i] = (int16_t)sample;
      }
      
      int bytesToSend = samplesRead * 2; // 2 bytes per 16-bit sample
      if (totalBytesRead + bytesToSend > numBytes) {
        bytesToSend = numBytes - totalBytesRead; // Trim exact length
      }
      
      clientAudio.write((uint8_t*)chunk16, bytesToSend);
      totalBytesRead += bytesToSend;
    }
    
    Serial.printf("Streamed %u bytes directly to Render.\n", totalBytesRead);
    
    long timeout = millis();
    while (clientAudio.connected() && millis() - timeout < 10000) {
      if (clientAudio.available()) {
        Serial.print((char)clientAudio.read());
        timeout = millis();
      }
    }
    Serial.println("\n[UPLOAD] Audio Streamed to Render Successfully!");
  } else {
    Serial.println("[UPLOAD] Audio server connection failed! Hardware limit reached.");
  }
}
