#include "esp_camera.h"
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>

// ===========================
// CONFIGURATION
// ===========================
const char* ssid = "vision";
const char* password = "12345678";

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

void setup() {
  Serial.begin(115200);
  Serial.println("Starting ESP32-CAM...");

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
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    delay(1000);
    return;
  }

  // Poll Node.js server every 1 second
  WiFiClientSecure secureClient;
  secureClient.setInsecure(); // Ignore SSL Validation for Render

  HTTPClient http;
  String statusUrl = String("https://") + serverIp + "/api/pi/status?t=" + String(millis());
  http.begin(secureClient, statusUrl);
  
  int httpCode = http.GET();
  if (httpCode == HTTP_CODE_OK) {
    String payload = http.getString();
    
    // Check if the server wants a picture
    if (payload.indexOf("\"CAPTURE_IMAGE\"") >= 0 || payload.indexOf("CAPTURE_IMAGE") >= 0) {
      Serial.println("\n[TRIGGER] Received CAPTURE_IMAGE command. Capturing...");
      captureAndSendImage();
    }
  } else {
    Serial.printf("[HTTP] GET /api/pi/status failed, error: %s\n", http.errorToString(httpCode).c_str());
  }
  
  http.end();
  delay(1000); 
}

void captureAndSendImage() {
  camera_fb_t * fb = esp_camera_fb_get();
  if (!fb) {
    Serial.println("Camera capture failed");
    return;
  }

  Serial.printf("Captured JPEG: %u bytes\n", fb->len);

  String boundary = "----ESP32CamBoundary";
  String head = "--" + boundary + "\r\n";
  head += "Content-Disposition: form-data; name=\"image\"; filename=\"capture.jpg\"\r\n";
  head += "Content-Type: image/jpeg\r\n\r\n";
  String tail = "\r\n--" + boundary + "--\r\n";
  uint32_t totalLen = head.length() + fb->len + tail.length();

  WiFiClientSecure client2;
  client2.setInsecure(); // Required for Render HTTPS Upload

  if(client2.connect(serverIp, serverPort)) {
    client2.print("POST /api/pi/image-input HTTP/1.1\r\n");
    client2.print("Host: " + String(serverIp) + "\r\n");
    client2.print("Connection: close\r\n"); // FORCE CLOUDFLARE TO STOP WAITING
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
    Serial.println("\n[UPLOAD] Image Sent to Render Successfully!");
  } else {
    Serial.println("[UPLOAD] Render connection failed!");
  }
  esp_camera_fb_return(fb); // free buffer
}
