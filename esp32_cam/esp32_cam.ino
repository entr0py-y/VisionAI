#include "esp_camera.h"
#include <WiFi.h>
#include <WebServer.h>

// ===========================
// CONFIGURATION — Connect to VisionAID SoftAP
// ===========================
const char *ssid = "VisionAID";
const char *password = "visionaid123";

// Static IP on the SoftAP network (ESP32-MIC is 192.168.4.1)
IPAddress local_IP(192, 168, 4, 2);
IPAddress gateway(192, 168, 4, 1);
IPAddress subnet(255, 255, 255, 0);

// ===========================
// CAMERA PINS (AI-Thinker)
// ===========================
#define PWDN_GPIO_NUM 32
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM 0
#define SIOD_GPIO_NUM 26
#define SIOC_GPIO_NUM 27
#define Y9_GPIO_NUM 35
#define Y8_GPIO_NUM 34
#define Y7_GPIO_NUM 39
#define Y6_GPIO_NUM 36
#define Y5_GPIO_NUM 21
#define Y4_GPIO_NUM 19
#define Y3_GPIO_NUM 18
#define Y2_GPIO_NUM 5
#define VSYNC_GPIO_NUM 25
#define HREF_GPIO_NUM 23
#define PCLK_GPIO_NUM 22

// Camera health status tracking
bool camInitialized = false;
esp_err_t camInitError = ESP_OK;

// Local HTTP server for serving captured images
WebServer server(80);

// ===========================
// HTTP HANDLERS
// ===========================

// GET /capture — Capture fresh JPEG from sensor and stream it to the client
void handleCapture() {
  Serial.println("[CAM] Capture requested...");
  
  if (!camInitialized) {
    Serial.printf("[CAM] Cannot capture: Camera hardware init failed at boot (error 0x%x)!\n", camInitError);
    server.sendHeader("Access-Control-Allow-Origin", "*");
    char errBody[128];
    snprintf(errBody, sizeof(errBody), "Camera not initialized (error 0x%x). Check PSRAM and ribbon cable.", camInitError);
    server.send(500, "text/plain", errBody);
    return;
  }

  // Attempt to capture frame with retries (avoids DMA/VSYNC timeout issues)
  camera_fb_t *fb = NULL;
  for (int attempt = 1; attempt <= 3; attempt++) {
    fb = esp_camera_fb_get();
    if (fb) {
      break;
    }
    Serial.printf("[CAM] Capture attempt %d failed, retrying in 50ms...\n", attempt);
    delay(50);
  }

  if (!fb) {
    server.sendHeader("Access-Control-Allow-Origin", "*");
    server.send(500, "text/plain", "Camera capture failed: sensor frame timeout");
    Serial.println("[CAM] Capture FAILED! (Sensor timeout or power dip)");
    return;
  }

  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  server.sendHeader("Cache-Control", "no-cache, no-store");
  
  // Inform client of exact binary JPEG size
  server.setContentLength(fb->len);
  server.send(200, "image/jpeg", "");
  
  // Stream raw JPEG bytes to client socket in chunks
  WiFiClient client = server.client();
  if (client.connected()) {
    uint8_t *buf = fb->buf;
    size_t remaining = fb->len;
    while (remaining > 0 && client.connected()) {
      size_t chunkSize = (remaining > 2048) ? 2048 : remaining;
      client.write(buf, chunkSize);
      buf += chunkSize;
      remaining -= chunkSize;
    }
  }
  
  esp_camera_fb_return(fb);
  Serial.printf("[CAM] Served JPEG: %u bytes\n", fb->len);
}

// GET /status — Health check for the phone to verify CAM is online and operational
void handleStatus() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  char json[200];
  snprintf(json, sizeof(json), 
    "{\"status\":\"online\",\"type\":\"ESP32_CAM\",\"cam_ok\":%s,\"psram\":%s,\"heap\":%u,\"cam_err\":%d}",
    camInitialized ? "true" : "false",
    psramFound() ? "true" : "false",
    ESP.getFreeHeap(),
    (int)camInitError);
  server.send(200, "application/json", json);
}

// GET /reinit — Try to reinitialize camera on the fly without board reboot
void handleReinit() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  Serial.println("[CAM] Manual camera re-init requested...");
  esp_camera_deinit();
  delay(100);
  extern void initCameraHardware();
  initCameraHardware();
  char json[128];
  snprintf(json, sizeof(json), "{\"cam_ok\":%s,\"cam_err\":%d}", camInitialized ? "true" : "false", (int)camInitError);
  server.send(200, "application/json", json);
}

// OPTIONS — CORS preflight handler
void handleCORS() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "*");
  server.send(204);
}

void initCameraHardware() {
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

  if (psramFound()) {
    config.frame_size = FRAMESIZE_VGA;
    config.jpeg_quality = 12;
    config.fb_count = 2; // Double buffering with PSRAM
#if defined(CAMERA_GRAB_LATEST)
    config.grab_mode = CAMERA_GRAB_LATEST; // Driver automatically keeps newest frame
#endif
  } else {
    config.frame_size = FRAMESIZE_CIF;
    config.jpeg_quality = 14;
    config.fb_count = 1;
#if defined(CAMERA_FB_IN_DRAM)
    config.fb_location = CAMERA_FB_IN_DRAM;
#endif
  }

  // Attempt 1: 20MHz (Standard)
  camInitError = esp_camera_init(&config);
  
  // Attempt 2: If 20MHz fails, try 10MHz (Tolerant of clock jitter)
  if (camInitError != ESP_OK) {
    Serial.printf("[CAM] 20MHz init returned 0x%x, retrying at 10MHz...\n", camInitError);
    esp_camera_deinit();
    delay(100);
    config.xclk_freq_hz = 10000000;
    camInitError = esp_camera_init(&config);
  }

  if (camInitError != ESP_OK) {
    camInitialized = false;
    Serial.printf("[CAM] ERROR: esp_camera_init failed with error 0x%x\n", camInitError);
    if (camInitError == ESP_ERR_NO_MEM) {
      Serial.println("[CAM] -> Reason: OUT OF MEMORY. In Arduino IDE, set Tools -> PSRAM -> Enabled!");
    } else {
      Serial.println("[CAM] -> Reason: HARDWARE FAILURE (-1 / 0x105). Check OV2640 ribbon cable!");
      Serial.println("[CAM] -> Fix: Push ribbon all the way into connector with golden contacts facing DOWN.");
    }
  } else {
    camInitialized = true;
    Serial.println("[CAM] Camera initialized successfully!");
    
    // Perform image inversion via hardware
    sensor_t * s = esp_camera_sensor_get();
    if (s) {
      s->set_vflip(s, 1);
      s->set_hmirror(s, 1);
    }
  }
}

void setup() {
  Serial.begin(115200);
  Serial.setDebugOutput(true); // Enables low-level ESP-IDF camera driver logs in Serial Monitor
  delay(1000); // Allow serial monitor to catch boot messages
  Serial.println("\n\n========================================");
  Serial.println("  Starting ESP32-CAM (SoftAP Client Mode)");
  Serial.println("========================================");

  // Diagnostic: Check Chip & PSRAM
  Serial.printf("[SYSTEM] Chip Model: %s (Rev %d)\n", ESP.getChipModel(), ESP.getChipRevision());
  if (psramFound()) {
    Serial.printf("[SYSTEM] PSRAM Detected: %u KB free\n", ESP.getFreePsram() / 1024);
  } else {
    Serial.println("[SYSTEM] PSRAM NOT Detected!");
    Serial.println("[SYSTEM] Note: In Arduino IDE, make sure 'Tools -> PSRAM -> Enabled' is selected.");
  }
  Serial.printf("[SYSTEM] Free internal heap: %u bytes\n", ESP.getFreeHeap());

  // STEP 1: INITIALIZE CAMERA FIRST (Before Wi-Fi turns on!)
  // Eliminates voltage drops and DMA contention that cause -1 (ESP_FAIL)
  Serial.println("[CAM] Initializing camera hardware first...");
  initCameraHardware();

  // STEP 2: CONNECT TO VisionAID NETWORK (created by ESP32-MIC)
  WiFi.mode(WIFI_STA);
  WiFi.config(local_IP, gateway, subnet);
  WiFi.begin(ssid, password);
  
  Serial.printf("[WIFI] Connecting to '%s'...\n", ssid);
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 40) {
    delay(500);
    Serial.print(".");
    attempts++;
  }
  
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("\n[WIFI] Initial connect failed. Retrying indefinitely...");
    Serial.println("[WIFI] Make sure ESP32-MIC is powered on and broadcasting VisionAID network.");
    while (WiFi.status() != WL_CONNECTED) {
      WiFi.disconnect();
      delay(1000);
      WiFi.begin(ssid, password);
      delay(5000);
      Serial.print("R");
    }
  }
  
  Serial.println("\n[WIFI] Connected to VisionAID!");
  Serial.printf("[WIFI] IP Address: %s\n", WiFi.localIP().toString().c_str());

  // STEP 3: START LOCAL HTTP SERVER
  server.on("/capture", HTTP_GET, handleCapture);
  server.on("/capture", HTTP_OPTIONS, handleCORS);
  server.on("/status", HTTP_GET, handleStatus);
  server.on("/status", HTTP_OPTIONS, handleCORS);
  server.on("/reinit", HTTP_GET, handleReinit);
  server.on("/reinit", HTTP_OPTIONS, handleCORS);
  server.begin();
  
  Serial.println("\n========================================");
  Serial.println("  ESP32-CAM Ready (SoftAP Client)!");
  Serial.printf("  Camera Status: %s\n", camInitialized ? "READY" : "FAILED (check ribbon cable)");
  Serial.printf("  Connected to: %s\n", ssid);
  Serial.printf("  Capture URL: http://%s/capture\n", WiFi.localIP().toString().c_str());
  Serial.printf("  Status URL:  http://%s/status\n", WiFi.localIP().toString().c_str());
  Serial.println("========================================\n");
}

void loop() {
  server.handleClient();
  
  // Auto-reconnect to VisionAID network if disconnected
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[WIFI] Disconnected from VisionAID! Reconnecting...");
    WiFi.disconnect();
    delay(1000);
    WiFi.begin(ssid, password);
    
    int attempts = 0;
    while (WiFi.status() != WL_CONNECTED && attempts < 20) {
      delay(500);
      Serial.print(".");
      attempts++;
    }
    
    if (WiFi.status() == WL_CONNECTED) {
      Serial.println("\n[WIFI] Reconnected!");
    }
  }
}
