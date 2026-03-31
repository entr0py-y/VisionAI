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
  // To avoid Heap Fragmentation crashes (where ESP32 has RAM but not in one contiguous block)
  // We allocate memory in multiple disjoint blocks to completely scavenge available RAM!
  const int NUM_BLOCKS = 12; // 12 blocks * 10KB = 120KB (~3.75 Seconds) 
  const int BLOCK_SIZE = 10000;
  uint8_t* audioBlocks[NUM_BLOCKS];
  int blocksAllocated = 0;
  
  for(int i = 0; i < NUM_BLOCKS; i++) {
      // Try PSRAM first, fallback to internal Heap
      audioBlocks[i] = (uint8_t*) heap_caps_malloc(BLOCK_SIZE, MALLOC_CAP_8BIT | MALLOC_CAP_SPIRAM);
      if(!audioBlocks[i]) audioBlocks[i] = (uint8_t*) malloc(BLOCK_SIZE);
      if(!audioBlocks[i]) {
          Serial.printf("⚠️ Memory Warning: Only squeezed %d / %d blocks from heap.\n", i, NUM_BLOCKS);
          break;
      }
      blocksAllocated++;
  }
  
  if (blocksAllocated == 0) {
      Serial.println("❌ FAILED to allocate ANY RAM for audio buffer! Rebooting...");
      return;
  }

  uint32_t TOTAL_MAX_BYTES = blocksAllocated * BLOCK_SIZE;
  i2s_zero_dma_buffer(I2S_PORT);
  size_t totalBytesRecorded = 0;
  const size_t maxRemoteBytes = 96000; // 3.0 seconds if requested from web

  Serial.println("🔴 RECORDING INSTANTLY...");

  uint32_t lastReadTime = millis();

  while (true) {
    if (isRemotelyTriggered) {
       if (totalBytesRecorded >= maxRemoteBytes) break;
    } else {
       if (digitalRead(TOUCH_PIN) == LOW) {
          // Guarantee at least 0.5s is recorded so HTTP doesn't reject it
          if (millis() - lastReadTime > 500) break; 
       }
       if (totalBytesRecorded >= TOTAL_MAX_BYTES) {
          Serial.println("⚠️ Warning: Block buffer FULL! Capping recording length.");
          break;
       }
    }

    uint8_t chunk32[2048]; // 512 samples
    size_t bytesToRead = 2048; 
    size_t bytesRead = 0;
    i2s_read(I2S_PORT, chunk32, bytesToRead, &bytesRead, portMAX_DELAY);

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
    
    // Distribute these bytes flawlessly across fragmented memory blocks!
    int bytesWrittenThisLoop = 0;
    while(bytesWrittenThisLoop < bytesToSend) {
        if (totalBytesRecorded >= TOTAL_MAX_BYTES) break;
        
        int blockIndex = totalBytesRecorded / BLOCK_SIZE;
        int offsetInBlock = totalBytesRecorded % BLOCK_SIZE;
        
        int spaceLeftInBlock = BLOCK_SIZE - offsetInBlock;
        int chunkRemaining = bytesToSend - bytesWrittenThisLoop;
        
        int bytesToCopy = (chunkRemaining < spaceLeftInBlock) ? chunkRemaining : spaceLeftInBlock;
        
        memcpy(audioBlocks[blockIndex] + offsetInBlock, ((uint8_t*)chunk16) + bytesWrittenThisLoop, bytesToCopy);
        
        totalBytesRecorded += bytesToCopy;
        bytesWrittenThisLoop += bytesToCopy;
    }
  }
  
  Serial.printf("⏹️ STOPPED. Captured %u bytes natively.\n", totalBytesRecorded);
  Serial.println("Establishing HTTPS connection and uploading natively...");

  WiFiClientSecure clientAudio;
  clientAudio.setInsecure();

  if (clientAudio.connect(serverIp, serverPort)) {
    clientAudio.print("POST /api/pi/audio-input HTTP/1.1\r\n");
    clientAudio.print("Host: " + String(serverIp) + "\r\n");
    clientAudio.print("Connection: close\r\n"); 
    clientAudio.print("Content-Type: application/octet-stream\r\n");
    clientAudio.print("Content-Length: " + String(totalBytesRecorded) + "\r\n\r\n");

    // Upload stored disjoint blocks securely
    size_t offset = 0;
    while (offset < totalBytesRecorded) {
        int blockIndex = offset / BLOCK_SIZE;
        int offsetInBlock = offset % BLOCK_SIZE;
        int spaceLeftInBlock = BLOCK_SIZE - offsetInBlock;
        
        int bytesRemainingToUpload = totalBytesRecorded - offset;
        int sendSize = (bytesRemainingToUpload < spaceLeftInBlock) ? bytesRemainingToUpload : spaceLeftInBlock;
        
        clientAudio.write(audioBlocks[blockIndex] + offsetInBlock, sendSize);
        offset += sendSize;
    }

    Serial.println("✅ Audio completely sent to the cloud.");

    long timeout = millis();
    while (clientAudio.connected() && millis() - timeout < 7000) {
      if (clientAudio.available()) {
        clientAudio.read();
        timeout = millis();
      }
    }
    Serial.println("[UPLOAD] Pipeline response received.");
  } else {
    Serial.println("❌ [UPLOAD] Audio server connection failed! Check WiFi or Server.");
  }

  // Free MEMORY cleanly back to FreeRTOS!
  for(int i = 0; i < blocksAllocated; i++) {
      free(audioBlocks[i]);
  }
}
