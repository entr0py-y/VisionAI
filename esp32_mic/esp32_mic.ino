#include <WiFi.h>
#include <WebSocketsClient.h>
#include <driver/i2s.h>

// ===========================
// CONFIGURATION
const char* ssid = "Heisenberg";
const char* password = "11111111";

// Cloud Server Configuration
const char* serverIp = "visionai-hig1.onrender.com";
const int serverPort = 443;

// ===========================
// I2S MIC PINS (INMP441)
// ===========================
#define I2S_WS 25
#define I2S_SCK 26
#define I2S_SD 33
#define I2S_PORT I2S_NUM_0

// ===========================
// EXTERNAL TOUCH BUTTON
// ===========================
#define TOUCH_PIN 13
#define LED_BUILTIN 2 // Most ESP32 Dev Boards have a blue LED on GPIO 2

WebSocketsClient webSocket;
bool isRecording = false;
bool lastTouchState = LOW;

void webSocketEvent(WStype_t type, uint8_t * payload, size_t length) {
  switch(type) {
    case WStype_DISCONNECTED:
      Serial.println("[WS] Disconnected from server!");
      break;
    case WStype_CONNECTED:
      Serial.printf("[WS] Connected to %s\n", payload);
      // Blink LED to indicate ready state
      for(int i=0; i<3; i++) {
        digitalWrite(LED_BUILTIN, HIGH); delay(100);
        digitalWrite(LED_BUILTIN, LOW); delay(100);
      }
      break;
    case WStype_TEXT:
      Serial.printf("[WS] Received msg: %s\n", payload);
      break;
  }
}

void setup() {
  Serial.begin(115200);
  Serial.println("Starting ESP32 Mic with WebSockets...");

  // 1. CONNECT TO WIFI
  WiFi.mode(WIFI_STA);       
  WiFi.disconnect(true);     
  delay(100);                
  
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nWiFi Connected!");
  Serial.print("IP Address: ");
  Serial.println(WiFi.localIP());

  pinMode(LED_BUILTIN, OUTPUT);

  // 2. CONFIGURE I2S MIC
  i2s_config_t i2s_config = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
    .sample_rate = 16000,
    .bits_per_sample = I2S_BITS_PER_SAMPLE_32BIT, // Must read 32-bit to capture INMP441's precision
    .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
    .communication_format = i2s_comm_format_t(I2S_COMM_FORMAT_I2S | I2S_COMM_FORMAT_I2S_MSB),
    .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
    .dma_buf_count = 16,
    .dma_buf_len = 1024,
    .use_apll = false,
    .tx_desc_auto_clear = false,
    .fixed_mclk = 0
  };
  
  i2s_pin_config_t pin_config = {
    .bck_io_num = I2S_SCK,
    .ws_io_num = I2S_WS,
    .data_out_num = -1, // No speaker
    .data_in_num = I2S_SD
  };
  
  esp_err_t err = i2s_driver_install(I2S_PORT, &i2s_config, 0, NULL);
  if (err != ESP_OK) {
    Serial.printf("I2S driver install failed: 0x%x\n", err);
  }
  i2s_set_pin(I2S_PORT, &pin_config);
  i2s_zero_dma_buffer(I2S_PORT);
  Serial.println("I2S Mic initialized.");

  // Physical Touch Button
  pinMode(TOUCH_PIN, INPUT_PULLDOWN);

  // 3. WS SERVER SETUP
  // Server cert validation is skipped for performance, using wss over port 443
  webSocket.beginSSL(serverIp, serverPort, "/api/pi/ws", "", "");
  webSocket.onEvent(webSocketEvent);
  
  // Try interval 5000ms
  webSocket.setReconnectInterval(5000);
}

void loop() {
  webSocket.loop();
  
  if (WiFi.status() != WL_CONNECTED) {
    return;
  }

  bool currentTouchState = digitalRead(TOUCH_PIN);
  
  if (currentTouchState == HIGH && lastTouchState == LOW) {
    if (webSocket.isConnected()) {
      Serial.println("\n[PTT] Interruption started! Beaming zero-latency signal...");
      digitalWrite(LED_BUILTIN, HIGH);
      
      // Sends signal to silence the text-to-speech engine instantly 
      webSocket.sendTXT("START");
      
      isRecording = true;
      i2s_zero_dma_buffer(I2S_PORT);
    } else {
      Serial.println("[ERR] WS not connected, cannot stream.");
    }
    delay(50); // debounce
  } 
  else if (currentTouchState == LOW && lastTouchState == HIGH && isRecording) {
    Serial.println("\n[PTT] Released! Finalizing buffer.");
    digitalWrite(LED_BUILTIN, LOW);
    
    // Command backend to process the audio via Groq Whisper + LLM
    webSocket.sendTXT("STOP");
    isRecording = false;
    
    delay(50); // debounce
  }
  
  lastTouchState = currentTouchState;

  // Real-time zero copy audio passthrough
  if (isRecording) {
    uint8_t chunk32[2048]; // 512 samples
    size_t bytesRead = 0;
    i2s_read(I2S_PORT, chunk32, 2048, &bytesRead, portMAX_DELAY);

    if (bytesRead > 0) {
      int samplesRead = bytesRead / 4; 
      int32_t* ptr32 = (int32_t*)chunk32;
      int16_t chunk16[512]; // Convert 32-bit to 16-bit
      
      for(int i = 0; i < samplesRead; i++) {
        int32_t sample = ptr32[i] >> 14; 
        if (sample > 32767) sample = 32767;
        if (sample < -32768) sample = -32768;
        chunk16[i] = (int16_t)sample;
      }
      
      int bytesToSend = samplesRead * 2;
      webSocket.sendBIN((uint8_t*)chunk16, bytesToSend);
    }
  }
}