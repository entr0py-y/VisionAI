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

// Local HTTP server for serving captured images
WebServer server(80);

// ===========================
// HTTP HANDLERS
// ===========================

// GET /capture — Flush stale frame, capture fresh JPEG, return it
void handleCapture() {
  Serial.println("[CAM] Capture requested...");
  
  // Flush stale frame (since fb_count is 1, the oldest frame is buffered)
  camera_fb_t *stale = esp_camera_fb_get();
  if (stale) {
    esp_camera_fb_return(stale);
  }

  // Capture fresh real-time frame
  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) {
    server.send(500, "text/plain", "Camera capture failed");
    Serial.println("[CAM] Capture FAILED!");
    return;
  }

  // Send JPEG directly to client via raw WiFiClient for efficiency
  WiFiClient client = server.client();
  
  String head = "HTTP/1.1 200 OK\r\n";
  head += "Content-Type: image/jpeg\r\n";
  head += "Content-Length: " + String(fb->len) + "\r\n";
  head += "Access-Control-Allow-Origin: *\r\n";
  head += "Access-Control-Allow-Methods: GET, OPTIONS\r\n";
  head += "Cache-Control: no-cache, no-store\r\n";
  head += "Connection: close\r\n\r\n";
  
  client.print(head);
  
  // Stream JPEG data in chunks
  uint8_t *fbBuf = fb->buf;
  size_t fbLen = fb->len;
  for (size_t n = 0; n < fbLen; n += 1024) {
    if (n + 1024 <= fbLen) {
      client.write(fbBuf + n, 1024);
    } else {
      client.write(fbBuf + n, fbLen - n);
    }
  }
  
  esp_camera_fb_return(fb);
  Serial.printf("[CAM] Served JPEG: %u bytes\n", fbLen);
}

// GET /status — Health check for the phone to verify CAM is online
void handleStatus() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  char json[128];
  snprintf(json, sizeof(json), 
    "{\"status\":\"online\",\"type\":\"ESP32_CAM\",\"heap\":%u}",
    ESP.getFreeHeap());
  server.send(200, "application/json", json);
}

// OPTIONS — CORS preflight handler
void handleCORS() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "*");
  server.send(204);
}

void setup() {
  Serial.begin(115200);
  Serial.println("Starting ESP32-CAM (SoftAP Client Mode)...");

  // 1. CONNECT TO VisionAID NETWORK (created by ESP32-MIC)
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
  if (psramFound()) {
    config.frame_size = FRAMESIZE_VGA;
    config.jpeg_quality = 12;
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
    
    // Perform image inversion via hardware
    sensor_t * s = esp_camera_sensor_get();
    if (s) {
      s->set_vflip(s, 1);
      s->set_hmirror(s, 1);
    }
  }

  // 3. START LOCAL HTTP SERVER
  server.on("/capture", HTTP_GET, handleCapture);
  server.on("/capture", HTTP_OPTIONS, handleCORS);
  server.on("/status", HTTP_GET, handleStatus);
  server.on("/status", HTTP_OPTIONS, handleCORS);
  server.begin();
  
  Serial.println("\n========================================");
  Serial.println("  ESP32-CAM Ready (SoftAP Client)!");
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
