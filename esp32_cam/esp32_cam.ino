#include "esp_camera.h"
#include <WiFi.h>
#include <HTTPClient.h>

// ===========================
// CONFIGURATION
// ===========================
const char* ssid = "YOUR_WIFI_SSID";
const char* password = "YOUR_WIFI_PASSWORD";

// Replace with your Mac's IP address (e.g., 10.68.150.17)
const char* serverIp = "10.68.150.17";
const int serverPort = 3000;

// Currency notes need clean, non-mirrored, high-detail frames.
// Keep these at 0 unless your physical mounting needs a correction.
const bool CAMERA_HMIRROR = false;
const bool CAMERA_VFLIP = false;

// ===========================
// PINOUT FOR AI-THINKER ESP32-CAM
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

  // CONNECT TO WIFI
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nWiFi Connected!");
  Serial.print("IP Address: ");
  Serial.println(WiFi.localIP());

  // CONFIGURE CAMERA
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

  // Frame parameters
  if(psramFound()){
    config.frame_size = FRAMESIZE_SVGA; // 800x600 for better text/detail
    config.jpeg_quality = 9;
    config.fb_count = 2;
  } else {
    config.frame_size = FRAMESIZE_VGA;
    config.jpeg_quality = 11;
    config.fb_count = 1;
  }

  // Initialize camera
  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("Camera init failed with error 0x%x\n", err);
    return;
  }

  sensor_t *s = esp_camera_sensor_get();
  if (s) {
    s->set_hmirror(s, CAMERA_HMIRROR ? 1 : 0);
    s->set_vflip(s, CAMERA_VFLIP ? 1 : 0);
  }
  Serial.println("Camera initialized.");
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    delay(1000);
    return;
  }

  // Poll Node.js server every 1 second
  HTTPClient http;
  String statusUrl = String("http://") + serverIp + ":" + serverPort + "/api/pi/status";
  http.begin(statusUrl);
  
  int httpCode = http.GET();
  if (httpCode == HTTP_CODE_OK) {
    String payload = http.getString();
    // Checks if the response string contains the JSON flag "CAPTURE_IMAGE"
    if (payload.indexOf("\"CAPTURE_IMAGE\"") > 0 || payload.indexOf("CAPTURE_IMAGE") > 0) {
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
  // Capture picture
  camera_fb_t * fb = esp_camera_fb_get();
  if (!fb) {
    Serial.println("Camera capture failed");
    return;
  }

  Serial.printf("Captured JPEG: %u bytes\n", fb->len);

  // Send photo to Node.js backend
  HTTPClient http;
  String uploadUrl = String("http://") + serverIp + ":" + serverPort + "/api/pi/image-input";
  http.begin(uploadUrl);
  
  // Set boundaries for multipart/form-data
  String boundary = "----ESP32CamBoundary";
  http.addHeader("Content-Type", "multipart/form-data; boundary=" + boundary);

  // Build the HTTP multipart body
  String head = "--" + boundary + "\r\n";
  head += "Content-Disposition: form-data; name=\"image\"; filename=\"capture.jpg\"\r\n";
  head += "Content-Type: image/jpeg\r\n\r\n";
  
  String tail = "\r\n--" + boundary + "--\r\n";

  uint32_t totalLen = head.length() + fb->len + tail.length();

  // Open HTTP connection and configure size
  int uploadResult = http.sendRequest("POST", (uint8_t *)head.c_str(), head.length());
  
  // Need to send parts manually if using WiFiClient, but sendRequest with String buffer stream is better for big data.
  // Instead, let's use WiFiClient directly to stream to avoid memory limits
  WiFiClient *client = http.getStreamPtr();
  
  if(http.begin(uploadUrl)) {
    http.addHeader("Content-Type", "multipart/form-data; boundary=" + boundary);
    
    // We send data chunked or pre-calculated
    // It's safer to start a manual POST via client
  }
  http.end();
  
  // REAL UPLOAD STREAM
  WiFiClient client2;
  if(client2.connect(serverIp, serverPort)) {
    client2.print("POST /api/pi/image-input HTTP/1.1\r\n");
    client2.print("Host: " + String(serverIp) + "\r\n");
    client2.print("Content-Length: " + String(totalLen) + "\r\n");
    client2.print("Content-Type: multipart/form-data; boundary=" + boundary + "\r\n\r\n");
    
    // Write head
    client2.print(head);
    
    // Write JPEG bytes in chunks
    uint8_t *fbBuf = fb->buf;
    size_t fbLen = fb->len;
    for (size_t n=0; n<fbLen; n=n+1024) {
      if (n+1024 < fbLen) {
        client2.write(fbBuf, 1024);
        fbBuf += 1024;
      } else if (fbLen%1024>0) {
        size_t remainder = fbLen%1024;
        client2.write(fbBuf, remainder);
      }
    }   
    
    // Write tail
    client2.print(tail);
    
    // Read Response
    long timeout = millis();
    while (client2.connected() && millis() - timeout < 10000) {
      if (client2.available()) {
        char c = client2.read();
        Serial.print(c);
        timeout = millis();
      }
    }
    Serial.println("\n[UPLOAD] Image Sent Successfully!");
  } else {
    Serial.println("[UPLOAD] Server connection failed!");
  }

  // Return the frame buffer back to the driver for reuse
  esp_camera_fb_return(fb);
}
