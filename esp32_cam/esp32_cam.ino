#include "esp_camera.h"
#include <HTTPClient.h>
#include <WebSocketsClient.h> // OPTIMIZED: WebSocket replaces HTTP polling
#include <WiFi.h>
#include <WiFiClientSecure.h>

// ===========================
// CONFIGURATION
const char *ssid = "Heisenberg";
const char *password = "11111111";

// Cloud Server Configuration
const char *serverIp = "visionai-hig1.onrender.com";
const int serverPort = 443;

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

// OPTIMIZED: WebSocket client for instant capture commands
WebSocketsClient webSocket;
bool wsConnected = false;

// OPTIMIZED: WebSocket event handler — receives CAPTURE_NOW / PRELOAD_CAPTURE
void webSocketEvent(WStype_t type, uint8_t *payload, size_t length) {
  switch (type) {
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
    String msg = String((char *)payload);
    Serial.printf("[WS-CAM] Received: %s\n", msg.c_str());

    // OPTIMIZED: Instant capture on WebSocket push — zero polling delay
    if (msg == "CAPTURE_NOW" || msg == "PRELOAD_CAPTURE") {
      Serial.println(
          "\n[TRIGGER] Received capture command via WebSocket. Capturing...");
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
  if (psramFound()) {
    config.frame_size = FRAMESIZE_VGA;
    config.jpeg_quality =
        12; // Lowered from 10 to 12 to reduce file size & latency
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

  // 3. OPTIMIZED: Connect to server via WebSocket (same path as ESP32-MIC)
  webSocket.beginSSL(serverIp, serverPort, "/api/pi/ws", "", "");
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(5000);
  Serial.println(
      "[WS-CAM] WebSocket client started, waiting for connection...");
}

unsigned long lastCamPing = 0;

// OPTIMIZED: No more HTTP polling — just service WebSocket
void loop() {
  webSocket.loop();

  if (WiFi.status() != WL_CONNECTED) {
    delay(1000);
    return;
  }

  // Send a keep-alive ping every 5 seconds so the dashboard knows we are online
  if (wsConnected && (millis() - lastCamPing > 5000)) {
    webSocket.sendTXT("{\"type\":\"PING\"}");
    lastCamPing = millis();
  }
}

void captureAndSendImage(bool isPreload) {
  // FLUSH STALE FRAME: Since fb_count is 1, the camera driver buffers the
  // oldest unseen frame. We grab the existing frame and return it immediately
  // to clear the buffer.
  camera_fb_t *stale_fb = esp_camera_fb_get();
  if (stale_fb) {
    esp_camera_fb_return(stale_fb);
  }

  // NOW GRAB THE CURRENT REAL-TIME FRAME
  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) {
    Serial.println("Camera capture failed");
    return;
  }

  Serial.printf("Captured JPEG: %u bytes (preload: %s)\n", fb->len,
                isPreload ? "yes" : "no");

  // OPTIMIZED: Add preload query param for server to distinguish pre-warm
  // captures
  String boundary = "----ESP32CamBoundary";
  String head = "--" + boundary + "\r\n";
  head += "Content-Disposition: form-data; name=\"image\"; "
          "filename=\"capture.jpg\"\r\n";
  head += "Content-Type: image/jpeg\r\n\r\n";
  String tail = "\r\n--" + boundary + "--\r\n";
  uint32_t totalLen = head.length() + fb->len + tail.length();

  WiFiClientSecure client2;
  client2.setInsecure(); // Required for Render HTTPS Upload

  if (client2.connect(serverIp, serverPort)) {
    String path =
        isPreload ? "/api/pi/image-input?preload=true" : "/api/pi/image-input";
    client2.print("POST " + path + " HTTP/1.1\r\n");
    client2.print("Host: " + String(serverIp) + "\r\n");
    client2.print("Connection: close\r\n"); // FORCE CLOUDFLARE TO STOP WAITING
    client2.print("Content-Length: " + String(totalLen) + "\r\n");
    client2.print("Content-Type: multipart/form-data; boundary=" + boundary +
                  "\r\n\r\n");
    client2.print(head);

    // Write JPEG bytes in chunks
    uint8_t *fbBuf = fb->buf;
    size_t fbLen = fb->len;
    for (size_t n = 0; n < fbLen; n = n + 1024) {
      if (n + 1024 <= fbLen) {
        client2.write(fbBuf, 1024);
        fbBuf += 1024;
      } else {
        size_t remainder = fbLen % 1024;
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
    Serial.println("\n[UPLOAD] Image Sent to Render Successfully!");
  } else {
    Serial.println("[UPLOAD] Render connection failed!");
  }
  esp_camera_fb_return(fb); // free buffer
}
