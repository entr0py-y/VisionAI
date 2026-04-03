#include "esp_camera.h"
#include <WiFi.h>
#include <WebSocketsClient.h>  // OPTIMIZED: WebSocket replaces HTTP polling
#include <HTTPClient.h>
#include <WiFiClientSecure.h>

// ===========================
// CONFIGURATION
const char* ssid = "Heisenberg";
const char* password = "11111111";

// Cloud Server Configuration
const char* serverIp = "visionai-hig1.onrender.com";
const int serverPort = 443;

// ===========================
// CAMERA PINS (AI-Thinker)
// ===========================
#define PWDN_GPIO_NUM     32
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM      0
#define SIOD_GPIO_NUM     26
#define SIOC_GPIO_NUM     27
#define Y9_GPIO_NUM       35
#define Y8_GPIO_NUM       34
#define Y7_GPIO_NUM       39
#define Y6_GPIO_NUM       36
#define Y5_GPIO_NUM       21
#define Y4_GPIO_NUM       19
#define Y3_GPIO_NUM       18
#define Y2_GPIO_NUM        5
#define VSYNC_GPIO_NUM    25
#define HREF_GPIO_NUM     23
#define PCLK_GPIO_NUM     22

// OPTIMIZED: WebSocket client for instant capture commands
WebSocketsClient webSocket;
bool wsConnected = false;

// OPTIMIZED: WebSocket event handler — receives CAPTURE_NOW / PRELOAD_CAPTURE
void webSocketEvent(WStype_t type, uint8_t * payload, size_t length) {
  switch(type) {
    case WStype_DISCONNECTED:
      Serial.println("[WS-CAM] Disconnected from server!");
      wsConnected = false;
      break;
    case WStype_CONNECTED:
      Serial.printf("[WS-CAM] Connected to %s\n", payload);
      wsConnected = true;
      // Identify ourselves as ESP32_CAM so server routes capture commands here
      webSocket.sendTXT("{\"type\":\"ESP32_CAM\"}");
      Serial.println("[WS-CAM] Sent ESP32_CAM identification");
      break;
    case WStype_TEXT: {
      String msg = String((char*)payload);
      Serial.printf("[WS-CAM] Received: %s\n", msg.c_str());
      
      // OPTIMIZED: Instant capture on WebSocket push — zero polling delay
      if (msg == "CAPTURE_NOW" || msg == "PRELOAD_CAPTURE") {
        Serial.println("\n[TRIGGER] Received capture command via WebSocket. Capturing...");
        captureAndSendImage(msg == "PRELOAD_CAPTURE");
      }
      break;
    }
  }
}

void setup() {
  Serial.begin(115200);
  Serial.println("Starting ESP32-CAM (WebSocket Mode)...");

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
    config.frame_size = FRAMESIZE_SVGA;  // 800x600 — reliable with dual SSL
    config.jpeg_quality = 10;            // High quality JPEG
    config.fb_count = 2;                 // Double buffer for fresh frames
  } else {
    config.frame_size = FRAMESIZE_VGA;   // 640x480 — safe for no-PSRAM
    config.jpeg_quality = 12;
    config.fb_count = 1;
  }
  
  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("Camera init failed with error 0x%x\n", err);
  } else {
    Serial.println("Camera initialized.");
    sensor_t * s = esp_camera_sensor_get();
    s->set_vflip(s, 1);   // Flip it vertically
    s->set_hmirror(s, 1); // Mirror it horizontally
  }

  // 3. OPTIMIZED: Connect to server via WebSocket (same path as ESP32-MIC)
  webSocket.beginSSL(serverIp, serverPort, "/api/pi/ws", "", "");
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(5000);
  Serial.println("[WS-CAM] WebSocket client started, waiting for connection...");
}

// OPTIMIZED: No more HTTP polling — just service WebSocket
void loop() {
  webSocket.loop();
  
  if (WiFi.status() != WL_CONNECTED) {
    delay(1000);
    return;
  }
}

void captureAndSendImage(bool isPreload) {
  // SAFETY: Check free heap before attempting capture
  uint32_t freeHeap = ESP.getFreeHeap();
  Serial.printf("[MEM] Free heap before capture: %u bytes\n", freeHeap);
  if (freeHeap < 30000) {
    Serial.println("[MEM] Not enough RAM to capture safely — skipping");
    return;
  }

  // FLUSH STALE FRAME then grab fresh one
  camera_fb_t * stale_fb = esp_camera_fb_get();
  if (stale_fb) {
    esp_camera_fb_return(stale_fb);
  }
  delay(50); // Let sensor settle

  camera_fb_t * fb = esp_camera_fb_get();
  if (!fb) {
    Serial.println("Camera capture failed!");
    return;
  }

  Serial.printf("Captured JPEG: %u bytes (preload: %s)\n", fb->len, isPreload ? "yes" : "no");

  // STABILITY: Removed the WebSocket disconnect so it stays online 100% of the time.
  // We stream directly from fb->buf to save memory instead of making a copy buffer.
  size_t jpegLen = fb->len;

  // Build multipart headers
  String boundary = "----ESP32CamBoundary";
  String head = "--" + boundary + "\r\n";
  head += "Content-Disposition: form-data; name=\"image\"; filename=\"capture.jpg\"\r\n";
  head += "Content-Type: image/jpeg\r\n\r\n";
  String tail = "\r\n--" + boundary + "--\r\n";
  uint32_t totalLen = head.length() + jpegLen + tail.length();

  WiFiClientSecure client2;
  client2.setInsecure();
  client2.setTimeout(15);  // 15 second timeout

  if (client2.connect(serverIp, serverPort)) {
    String path = isPreload ? "/api/pi/image-input?preload=true" : "/api/pi/image-input";
    client2.print("POST " + path + " HTTP/1.1\r\n");
    client2.print("Host: " + String(serverIp) + "\r\n");
    client2.print("Connection: close\r\n");
    client2.print("Content-Length: " + String(totalLen) + "\r\n");
    client2.print("Content-Type: multipart/form-data; boundary=" + boundary + "\r\n\r\n");
    client2.print(head);
    
    // Write JPEG bytes in chunks with yield() to prevent watchdog reset
    size_t offset = 0;
    while (offset < jpegLen) {
      size_t chunkSize = min((size_t)1024, jpegLen - offset);
      client2.write(fb->buf + offset, chunkSize);
      offset += chunkSize;
      yield();  // Feed the watchdog
    }
    client2.print(tail);
    
    // Wait for server response (with timeout)
    long timeout = millis();
    while (client2.connected() && millis() - timeout < 10000) {
      if (client2.available()) {
        Serial.print((char)client2.read());
        timeout = millis();
      }
      yield();
    }
    Serial.println("\n[UPLOAD] Image sent successfully!");
  } else {
    Serial.println("[UPLOAD] Server connection failed!");
  }

  client2.stop();
  esp_camera_fb_return(fb);  // FREE camera frame buffer only AFTER upload is complete
}
