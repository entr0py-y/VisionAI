#include "esp_camera.h"
#include <HTTPClient.h>
#include <WebSocketsClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include "soc/soc.h"
#include "soc/rtc_cntl_reg.h"

// ===========================
// CONFIGURATION
// ===========================
const char *ssid = "Heisenberg69";
const char *password = "11111111";

// Cloud Server Configuration
const char *serverIp = "visionaid-5ut9.onrender.com";
const int serverPort = 443;

// ==============================================================================
// CAMERA PINS (AI-Thinker ESP32-CAM / ESP32 Dev Module)
// ==============================================================================
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

WebSocketsClient webSocket;
bool wsConnected = false;
unsigned long lastCamPing = 0;
unsigned long lastWiFiCheck = 0;

void captureAndSendImage(bool isPreload);

void webSocketEvent(WStype_t type, uint8_t *payload, size_t length) {
  switch (type) {
  case WStype_DISCONNECTED:
    Serial.println("[WS-CAM] Disconnected from server!");
    wsConnected = false;
    break;
  case WStype_CONNECTED:
    Serial.printf("[WS-CAM] Connected to %s\n", payload);
    wsConnected = true;
    webSocket.sendTXT("{\"type\":\"ESP32_CAM\"}");
    break;
  case WStype_TEXT: {
    String msg = String((char *)payload);
    Serial.printf("[WS-CAM] Received: %s\n", msg.c_str());
    if (msg == "CAPTURE_NOW" || msg == "PRELOAD_CAPTURE") {
      captureAndSendImage(msg == "PRELOAD_CAPTURE");
    }
    break;
  }
  default:
    break;
  }
}

void setup() {
  WRITE_PERI_REG(RTC_CNTL_BROWN_OUT_REG, 0);
  Serial.begin(115200);

  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password);

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
    config.frame_size = FRAMESIZE_SVGA;
    config.jpeg_quality = 12;
    config.fb_count = 1;
  }

  esp_err_t err = esp_camera_init(&config);
  if (err == ESP_OK) {
    sensor_t * s = esp_camera_sensor_get();
    if (s) {
      s->set_vflip(s, 1);
      s->set_hmirror(s, 1);
    }
  } else {
    Serial.printf("[CAM] Camera init failed: 0x%x\n", err);
  }

  webSocket.beginSSL(serverIp, serverPort, "/api/pi/ws");
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(5000);
}

void loop() {
  webSocket.loop();

  // WiFi auto-reconnect logic
  if (WiFi.status() != WL_CONNECTED) {
    if (millis() - lastWiFiCheck >= 5000) {
      Serial.println("[WIFI] Disconnected. Reconnecting...");
      WiFi.disconnect();
      WiFi.reconnect();
      lastWiFiCheck = millis();
    }
    return;
  }

  if (wsConnected && (millis() - lastCamPing > 5000)) {
    webSocket.sendTXT("{\"type\":\"ESP32_CAM\"}");
    lastCamPing = millis();
  }
}

void captureAndSendImage(bool isPreload) {
  camera_fb_t *stale_fb = esp_camera_fb_get();
  if (stale_fb) {
    esp_camera_fb_return(stale_fb);
  }

  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) {
    Serial.println("[CAM] Capture failed!");
    return;
  }

  Serial.printf("[CAM] Captured %u bytes\n", fb->len);

  if (!wsConnected) {
    Serial.println("[UPLOAD] WS not connected, skipping.");
    esp_camera_fb_return(fb);
    return;
  }

  // Send a JSON header so the server knows binary image data is coming
  String header = isPreload ? "{\"type\":\"CAM_IMAGE\",\"preload\":true}" : "{\"type\":\"CAM_IMAGE\"}";
  webSocket.sendTXT(header);

  // Send the JPEG image as binary over the existing WebSocket connection
  // Chunk it to avoid overwhelming the WS buffer
  uint8_t *fbBuf = fb->buf;
  size_t fbLen = fb->len;
  size_t chunkSize = 1024;

  for (size_t offset = 0; offset < fbLen; offset += chunkSize) {
    size_t len = (offset + chunkSize <= fbLen) ? chunkSize : (fbLen - offset);
    webSocket.sendBIN(fbBuf + offset, len);
    webSocket.loop(); // Keep WS alive between chunks
  }

  // Send end marker so server knows the image is complete
  webSocket.sendTXT("{\"type\":\"CAM_IMAGE_END\"}");

  Serial.printf("[UPLOAD] Sent %u bytes over WebSocket\n", fbLen);
  esp_camera_fb_return(fb);
}
