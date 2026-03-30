#include "esp_camera.h"
#include <WiFi.h>
#include <HTTPClient.h>
#include <driver/i2s.h>

// ===========================
// CONFIGURATION
// ===========================
const char* ssid = "vision";
const char* password = "12345678";

// Your Mac's IP address (dynamically updated)
const char* serverIp = "10.189.62.17";
const int serverPort = 3000;

// ===========================
// I2S MIC PINS (INMP441)
// ===========================
#define I2S_WS 25
#define I2S_SCK 26
#define I2S_SD 33
#define I2S_PORT I2S_NUM_0

// ===========================
// CAMERA PINS (AI-Thinker)
// ===========================
// NOTE: On standard AI-Thinker ESP32-CAMs, GPIO25 is VSYNC and 
// GPIO26 is SIOD. Wiring the Mic here will cause conflicts.
// If using an AI-Thinker ESP32-CAM, you may need to use different 
// pins for the mic (like 14, 15, 13) and change the board settings. 
// Standard pinouts kept below.
#define PWDN_GPIO_NUM     32
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM      0
#define SIOD_GPIO_NUM     26 // CONFLICT with I2S_SCK
#define SIOC_GPIO_NUM     27
#define Y9_GPIO_NUM       35
#define Y8_GPIO_NUM       34
#define Y7_GPIO_NUM       39
#define Y6_GPIO_NUM       36
#define Y5_GPIO_NUM       21
#define Y4_GPIO_NUM       19
#define Y3_GPIO_NUM       18
#define Y2_GPIO_NUM        5
#define VSYNC_GPIO_NUM    25 // CONFLICT with I2S_WS
#define HREF_GPIO_NUM     23
#define PCLK_GPIO_NUM     22

void setup() {
  Serial.begin(115200);
  Serial.println("Starting ESP32 WROOM / ESP-CAM...");

  // 1. CONNECT TO WIFI
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nWiFi Connected!");
  Serial.print("IP Address: ");
  Serial.println(WiFi.localIP());

  // 2. CONFIGURE CAMERA
  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;
  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG; 
  if(psramFound()){
    config.frame_size = FRAMESIZE_VGA;
    config.jpeg_quality = 10;
    config.fb_count = 1;
  } else {
    config.frame_size = FRAMESIZE_VGA;
    config.jpeg_quality = 12;
    config.fb_count = 1;
  }
  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("Camera init failed with error 0x%x\n", err);
  } else {
    Serial.println("Camera initialized.");
  }

  // 3. CONFIGURE I2S MIC
  i2s_config_t i2s_config = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
    .sample_rate = 16000,
    .bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT,
    .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
    .communication_format = I2S_COMM_FORMAT_STAND_I2S, // or I2S_COMM_FORMAT_I2S for older ESP32 cores
    .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
    .dma_buf_count = 8,
    .dma_buf_len = 512,
    .use_apll = false,
    .tx_desc_auto_clear = false,
    .fixed_mclk = 0
  };
  i2s_pin_config_t pin_config = {
    .bck_io_num = I2S_SCK,
    .ws_io_num = I2S_WS,
    .data_out_num = -1, // I2S_PIN_NO_CHANGE
    .data_in_num = I2S_SD
  };
  err = i2s_driver_install(I2S_PORT, &i2s_config, 0, NULL);
  if (err != ESP_OK) {
    Serial.printf("I2S driver install failed: 0x%x\n", err);
  }
  i2s_set_pin(I2S_PORT, &pin_config);
  i2s_zero_dma_buffer(I2S_PORT);
  Serial.println("I2S Mic initialized.");
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    delay(1000);
    return;
  }

  // Poll Node.js server every 1 second
  HTTPClient http;
  String statusUrl = String("http://") + serverIp + ":" + serverPort + "/api/pi/status?t=" + String(millis());
  http.begin(statusUrl);
  
  int httpCode = http.GET();
  if (httpCode == HTTP_CODE_OK) {
    String payload = http.getString();
    // Check what command backend sent
    if (payload.indexOf("\"CAPTURE_IMAGE\"") >= 0 || payload.indexOf("CAPTURE_IMAGE") >= 0) {
      Serial.println("\n[TRIGGER] Received CAPTURE_IMAGE command. Capturing...");
      captureAndSendImage();
    } else if (payload.indexOf("\"RECORD\"") >= 0 || payload.indexOf("RECORD") >= 0) {
      Serial.println("\n[TRIGGER] Received RECORD command. Recording Mic...");
      recordAndSendAudio();
    }
  } else {
    Serial.printf("[HTTP] GET /api/pi/status failed, error: %s\n", http.errorToString(httpCode).c_str());
  }
  
  http.end();
  delay(1000); // Check loop delay
}

void captureAndSendImage() {
  camera_fb_t * fb = esp_camera_fb_get();
  if (!fb) {
    Serial.println("Camera capture failed");
    return;
  }

  Serial.printf("Captured JPEG: %u bytes\n", fb->len);

  String uploadUrl = String("http://") + serverIp + ":" + serverPort + "/api/pi/image-input";
  String boundary = "----ESP32CamBoundary";
  String head = "--" + boundary + "\r\n";
  head += "Content-Disposition: form-data; name=\"image\"; filename=\"capture.jpg\"\r\n";
  head += "Content-Type: image/jpeg\r\n\r\n";
  String tail = "\r\n--" + boundary + "--\r\n";
  uint32_t totalLen = head.length() + fb->len + tail.length();

  WiFiClient client2;
  if(client2.connect(serverIp, serverPort)) {
    client2.print("POST /api/pi/image-input HTTP/1.1\r\n");
    client2.print("Host: " + String(serverIp) + "\r\n");
    client2.print("Content-Length: " + String(totalLen) + "\r\n");
    client2.print("Content-Type: multipart/form-data; boundary=" + boundary + "\r\n\r\n");
    client2.print(head);
    
    // Write JPEG bytes in chunks
    uint8_t *fbBuf = fb->buf;
    size_t fbLen = fb->len;
    for (size_t n=0; n<fbLen; n=n+1024) {
      if (n+1024 <= fbLen) {
        client2.write(fbBuf, 1024);
        fbBuf += 1024;
      } else {
        size_t remainder = fbLen%1024;
        client2.write(fbBuf, remainder);
      }
    }   
    client2.print(tail);
    
    long timeout = millis();
    while (client2.connected() && millis() - timeout < 10000) {
      if (client2.available()) {
        Serial.print((char)client2.read());
        timeout = millis();
      }
    }
    Serial.println("\n[UPLOAD] Image Sent Successfully!");
  } else {
    Serial.println("[UPLOAD] Server connection failed!");
  }
  esp_camera_fb_return(fb); // free buffer
}

void recordAndSendAudio() {
  // Record 3 seconds of audio at 16kHz, 16-bit
  const int recordTimeSec = 3;
  const int sampleRate = 16000;
  // bytes = 16000 * 2 (16bit) * duration
  const int numBytes = recordTimeSec * sampleRate * 2;
  
  uint8_t* audioBuffer = (uint8_t*)ps_malloc(numBytes); // Try PSRAM first
  if (!audioBuffer) {
    audioBuffer = (uint8_t*)malloc(numBytes); // fallback to heap
    if (!audioBuffer) {
      Serial.println("Failed to allocate audio buffer");
      return;
    }
  }

  Serial.println("Recording audio...");
  size_t totalBytesRead = 0;
  
  // Clean start (empty dma buffer)
  i2s_zero_dma_buffer(I2S_PORT);
  
  while (totalBytesRead < numBytes) {
    size_t bytesToRead = (numBytes - totalBytesRead) > 1024 ? 1024 : (numBytes - totalBytesRead);
    size_t bytesRead = 0;
    i2s_read(I2S_PORT, audioBuffer + totalBytesRead, bytesToRead, &bytesRead, portMAX_DELAY);
    totalBytesRead += bytesRead;
  }
  Serial.printf("Recorded %u bytes\n", totalBytesRead);

  // Send raw PCM AUDIO
  WiFiClient clientAudio;
  if (clientAudio.connect(serverIp, serverPort)) {
    clientAudio.print("POST /api/pi/audio-input HTTP/1.1\r\n");
    clientAudio.print("Host: " + String(serverIp) + "\r\n");
    clientAudio.print("Content-Type: application/octet-stream\r\n");
    clientAudio.print("Content-Length: " + String(totalBytesRead) + "\r\n\r\n");
    
    // Chunk upload to avoid overflow
    size_t sent = 0;
    while(sent < totalBytesRead) {
      size_t toSend = (totalBytesRead - sent) > 1024 ? 1024 : (totalBytesRead - sent);
      clientAudio.write(audioBuffer + sent, toSend);
      sent += toSend;
    }
    
    long timeout = millis();
    while (clientAudio.connected() && millis() - timeout < 10000) {
      if (clientAudio.available()) {
        Serial.print((char)clientAudio.read());
        timeout = millis();
      }
    }
    Serial.println("\n[UPLOAD] Audio Sent Successfully!");
  } else {
    Serial.println("[UPLOAD] Audio server connection failed!");
  }
  
  free(audioBuffer);
}
