#include "esp_camera.h"
#include <WiFi.h>
#include <WebServer.h>
#include "soc/soc.h"
#include "soc/rtc_cntl_reg.h"

// ===========================
// CONFIGURATION
// ===========================
// The network created by the ESP32 Mic Module
const char *ssid = "VisionAI";
const char *password = "11111111";

// We force the Camera to have a Static IP so the phone always knows where it is
IPAddress local_IP(192, 168, 4, 2);
IPAddress gateway(192, 168, 4, 1);
IPAddress subnet(255, 255, 255, 0);

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

// Local HTTP Server on port 80
WebServer server(80);
unsigned long lastWiFiCheck = 0;

// ===========================
// HTTP HANDLERS
// ===========================
void handleCapture() {
  Serial.println("\n[HTTP] Phone requested an image capture...");

  // FLUSH STALE FRAME: Drop previous buffer frame to capture fresh photo
  camera_fb_t *stale_fb = esp_camera_fb_get();
  if (stale_fb) {
    esp_camera_fb_return(stale_fb);
  }

  // Capture real-time frame
  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) {
    Serial.println("[CAM] Error: Camera capture failed!");
    server.send(500, "text/plain", "Camera capture failed");
    return;
  }

  Serial.printf("[CAM] Captured JPEG: %u bytes. Sending to phone...\n", fb->len);

  // Send the image directly from the camera buffer to the phone over HTTP
  // We use setContentLength and client.write to avoid memory copies which crash the ESP32
  server.setContentLength(fb->len);
  server.send(200, "image/jpeg", "");
  
  WiFiClient client = server.client();
  client.write(fb->buf, fb->len);

  // Return the frame buffer back to the camera driver
  esp_camera_fb_return(fb);
  
  Serial.println("[HTTP] Image sent successfully!");
}

void handleNotFound() {
  server.send(404, "text/plain", "Endpoint not found. Use /capture");
}

// ===========================
// SETUP
// ===========================
void setup() {
  // Disable brownout detector to prevent sudden reboots during Wi-Fi / Flash activity
  WRITE_PERI_REG(RTC_CNTL_BROWN_OUT_REG, 0);

  Serial.begin(115200);
  Serial.println("\n==================================================");
  Serial.println("[SYS] Starting ESP32-CAM (Station & Local Server)");
  Serial.println("==================================================");

  // 1. SETUP WIFI (STATION MODE & STATIC IP)
  if (!WiFi.config(local_IP, gateway, subnet)) {
    Serial.println("[WIFI] Warning: Static IP Failed to configure.");
  }
  
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password);
  
  Serial.printf("[WIFI] Connecting to AP '%s'...\n", ssid);
  int connectAttempts = 0;
  while (WiFi.status() != WL_CONNECTED && connectAttempts < 20) {
    delay(500);
    Serial.print(".");
    connectAttempts++;
  }
  
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n[WIFI] Connected to VisionAI Network!");
    Serial.print("[WIFI] Fixed IP Address: ");
    Serial.println(WiFi.localIP()); // Should be 192.168.4.2
  } else {
    Serial.println("\n[WIFI] Failed to connect! Make sure the Mic ESP32 is powered on.");
  }

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
    Serial.println("[CAM] WARNING: PSRAM not detected! Running in SVGA fallback mode.");
    config.frame_size = FRAMESIZE_SVGA;
    config.jpeg_quality = 12;
    config.fb_count = 1;
  }

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("[CAM] Camera init failed with error 0x%x\n", err);
  } else {
    Serial.println("[CAM] Camera initialized successfully.");
    
    // Invert image sensor if needed
    sensor_t * s = esp_camera_sensor_get();
    if (s) {
      s->set_vflip(s, 1);
      s->set_hmirror(s, 1);
    }
  }

  // 3. START HTTP SERVER
  server.on("/capture", HTTP_GET, handleCapture);
  server.onNotFound(handleNotFound);
  server.begin();
  
  Serial.println("[HTTP] Web Server started.");
  Serial.println("[HTTP] Waiting for requests at: http://192.168.4.2/capture");
}

// ===========================
// MAIN LOOP
// ===========================
void loop() {
  // Listen for incoming HTTP requests from the phone
  server.handleClient();

  // WiFi Reconnection Logic
  if (WiFi.status() != WL_CONNECTED) {
    if (millis() - lastWiFiCheck >= 5000) {
      Serial.println("[WIFI] Disconnected from Master ESP32. Reconnecting...");
      WiFi.disconnect();
      WiFi.reconnect();
      lastWiFiCheck = millis();
    }
  }
}
