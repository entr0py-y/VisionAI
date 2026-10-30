#include "esp_camera.h"
#include <HTTPClient.h>
#include <WebSocketsClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <Preferences.h>
#include <WebServer.h>
#include <DNSServer.h>
#include "soc/soc.h"
#include "soc/rtc_cntl_reg.h"

// ===========================
// CONFIGURATION & PREFERENCES
// ===========================
Preferences preferences;
WebServer configServer(80);
DNSServer dnsServer;

String currentSSID = "";
String currentPass = "";
bool inConfigPortal = false;

// Default fallback credentials if none saved in NVS
const char *default_ssid = "Heisenberg69";
const char *default_password = "11111111";

// Local Phone Hub WebSocket Server Configuration
const int serverPort = 8888;

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

// ─── CAPTIVE PORTAL WEB SERVER ───
void handlePortalRoot() {
  int n = WiFi.scanNetworks();
  String options = "";
  for (int i = 0; i < n; ++i) {
    options += "<option value='" + WiFi.SSID(i) + "'>" + WiFi.SSID(i) + " (" + String(WiFi.RSSI(i)) + " dBm)</option>";
  }

  String html = "<!DOCTYPE html><html><head><meta name='viewport' content='width=device-width, initial-scale=1.0'>"
    "<title>VisionAID CAM WiFi Setup</title>"
    "<style>"
    "body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;background:#0d1117;color:#c9d1d9;margin:0;padding:24px;display:flex;justify-content:center;align-items:center;min-height:100vh;box-sizing:border-box;}"
    ".card{background:#161b22;border:1px solid #30363d;border-radius:16px;padding:32px 24px;max-width:380px;width:100%;box-shadow:0 8px 24px rgba(0,0,0,0.5);}"
    "h2{margin-top:0;color:#58a6ff;font-size:22px;text-align:center;}"
    "p{font-size:14px;color:#8b949e;line-height:1.5;text-align:center;margin-bottom:24px;}"
    "label{font-size:13px;font-weight:600;display:block;margin-bottom:6px;color:#f0f6fc;}"
    "select,input[type=text],input[type=password]{width:100%;padding:12px;margin-bottom:18px;background:#0d1117;border:1px solid #30363d;border-radius:8px;color:#fff;font-size:15px;box-sizing:border-box;outline:none;}"
    "select:focus,input:focus{border-color:#58a6ff;}"
    "button{width:100%;padding:14px;background:#238636;color:#fff;border:none;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer;transition:0.2s;}"
    "button:active{background:#2ea043;transform:scale(0.98);}"
    ".badge{display:inline-block;background:#388bfd26;color:#58a6ff;padding:4px 10px;border-radius:20px;font-size:12px;margin-bottom:12px;}"
    "</style></head><body>"
    "<div class='card'>"
    "<div style='text-align:center;'><span class='badge'>VisionAID Camera Module</span></div>"
    "<h2>WiFi Configuration</h2>"
    "<p>Select your home or mobile hotspot WiFi network and enter the password.</p>"
    "<form action='/save' method='POST'>"
    "<label>Select Available WiFi</label>"
    "<select onchange='document.getElementById(\"custom_ssid\").value = this.value;'>"
    "<option value=''>-- Select network --</option>" + options +
    "</select>"
    "<label>Or Type SSID</label>"
    "<input type='text' id='custom_ssid' name='ssid' placeholder='WiFi Network Name' required>"
    "<label>Password</label>"
    "<input type='password' name='pass' placeholder='WiFi Password'>"
    "<button type='submit'>Save & Connect</button>"
    "</form></div></body></html>";

  configServer.send(200, "text/html", html);
}

void handlePortalSave() {
  String newSSID = configServer.arg("ssid");
  String newPass = configServer.arg("pass");

  if (newSSID.length() > 0) {
    preferences.begin("cam_wifi", false);
    preferences.putString("ssid", newSSID);
    preferences.putString("pass", newPass);
    preferences.end();

    String resp = "<!DOCTYPE html><html><body style='font-family:sans-serif;background:#0d1117;color:#fff;text-align:center;padding:40px;'>"
      "<h2 style='color:#3fb950;'>Credentials Saved!</h2>"
      "<p>ESP32-CAM is now restarting to connect to: <b>" + newSSID + "</b></p>"
      "<p style='color:#8b949e;font-size:13px;'>You can now reconnect your phone to your normal Wi-Fi.</p>"
      "</body></html>";
    configServer.send(200, "text/html", resp);
    delay(2000);
    ESP.restart();
  } else {
    configServer.send(400, "text/plain", "SSID cannot be empty.");
  }
}

void startConfigPortal() {
  inConfigPortal = true;
  WiFi.mode(WIFI_AP);
  WiFi.softAP("VisionAID-Cam-Setup");
  IPAddress IP = WiFi.softAPIP();
  Serial.print("[AP] Hotspot active! SSID: VisionAID-Cam-Setup. IP: http://");
  Serial.println(IP);

  dnsServer.start(53, "*", IP);

  configServer.on("/", handlePortalRoot);
  configServer.on("/save", HTTP_POST, handlePortalSave);
  configServer.onNotFound([]() {
    configServer.sendHeader("Location", "/", true);
    configServer.send(302, "text/plain", "");
  });
  configServer.begin();
}

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

  // Load saved credentials from NVS Flash
  preferences.begin("cam_wifi", false);
  currentSSID = preferences.getString("ssid", default_ssid);
  currentPass = preferences.getString("pass", default_password);
  preferences.end();

  Serial.printf("\n[CAM-WIFI] Attempting connection to SSID: %s\n", currentSSID.c_str());
  WiFi.mode(WIFI_STA);
  WiFi.begin(currentSSID.c_str(), currentPass.c_str());

  unsigned long startAttempt = millis();
  // Wait up to 60 seconds (60000ms)
  while (WiFi.status() != WL_CONNECTED && (millis() - startAttempt < 60000)) {
    delay(500);
    Serial.print(".");
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\n[CAM-WIFI] Connected! IP: %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println("\n[CAM-WIFI] Could not connect in 60s! Launching Config Hotspot...");
    startConfigPortal();
    return;
  }

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
    Serial.println("[CAM] PSRAM found! Using high-res mode.");
    config.frame_size = FRAMESIZE_VGA;     // 640x480 — reliable with PSRAM
    config.jpeg_quality = 8;               // High quality for QR readability
    config.fb_count = 1;
  } else {
    Serial.println("[CAM] No PSRAM. Using low-res mode.");
    config.frame_size = FRAMESIZE_QVGA;    // 320x240 — safe for no-PSRAM
    config.jpeg_quality = 10;
    config.fb_count = 1;
  }

  esp_err_t err = esp_camera_init(&config);
  if (err == ESP_OK) {
    sensor_t * s = esp_camera_sensor_get();
    if (s) {
      s->set_vflip(s, 1);
      s->set_hmirror(s, 1);
      // Sharper images for QR/text reading
      s->set_sharpness(s, 2);              // Increase edge sharpness (-2 to 2)
      s->set_contrast(s, 1);               // Slight contrast boost (-2 to 2)
      s->set_whitebal(s, 1);               // Auto white balance ON
      s->set_awb_gain(s, 1);               // AWB gain ON
      s->set_exposure_ctrl(s, 1);          // Auto exposure ON
      s->set_aec2(s, 1);                   // Advanced auto exposure ON
      s->set_gain_ctrl(s, 1);              // Auto gain ON
    }
  } else {
    Serial.printf("[CAM] Camera init failed: 0x%x\n", err);
  }

  IPAddress targetHub = WiFi.gatewayIP();
  Serial.printf("[CAM-WS] Connecting to Phone Hub at %s:%d\n", targetHub.toString().c_str(), serverPort);
  webSocket.begin(targetHub, serverPort, "/");
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(5000);
}

void loop() {
  if (inConfigPortal) {
    dnsServer.processNextRequest();
    configServer.handleClient();
    return;
  }

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

  if (wsConnected && (millis() - lastCamPing > 3000)) {
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
    if (wsConnected) {
      webSocket.sendTXT("{\"type\":\"CAM_ERROR\",\"message\":\"Capture failed, check hardware\"}");
    }
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
