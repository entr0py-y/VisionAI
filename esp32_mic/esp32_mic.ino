#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <WebSocketsClient.h>
#include <driver/i2s.h>

// ===========================
// CONFIGURATION
// ===========================
const char* ssid = "Heisenberg";
const char* password = "11111111";

const char* serverIp = "visionaid-5ut9.onrender.com";
const int serverPort = 443;

// I2S MIC PINS (INMP441)
#define I2S_SCK   26   
#define I2S_WS    25   
#define I2S_SD    33   
#define I2S_PORT  I2S_NUM_0

// EXTERNAL BUTTON & LED
#define TOUCH_PIN  18  
#define LED_PIN    2   

// SPATIAL SENSORS
#define PIR_PIN          19   
#define ULTRASONIC_TRIG  5    
#define ULTRASONIC_ECHO  17   

WebSocketsClient webSocket;
bool wsConnected = false;
bool isRecording = false;

// Debouncing variables
bool buttonState = LOW;
bool lastButtonState = LOW;
unsigned long lastDebounceTime = 0;
const unsigned long DEBOUNCE_DELAY = 50;

unsigned long lastSensorSend = 0;
unsigned long lastHeapLog = 0;
unsigned long lastWiFiCheck = 0;

// Global audio buffers to prevent heap fragmentation
#define AUDIO_BUFFER_SAMPLES 512
uint8_t pcm32Buffer[AUDIO_BUFFER_SAMPLES * 4]; 
int16_t pcm16Buffer[AUDIO_BUFFER_SAMPLES];

const unsigned long ALERT_INTERVAL = 200;   
const unsigned long IDLE_INTERVAL  = 400;   
unsigned long currentSensorInterval = IDLE_INTERVAL;

void ledOn() { digitalWrite(LED_PIN, HIGH); }
void ledOff() { digitalWrite(LED_PIN, LOW); }
void ledBlink(int times, int ms) {
  for (int i = 0; i < times; i++) {
    ledOn(); delay(ms);
    ledOff(); delay(ms);
  }
}

float emaDistance = -1;
const float EMA_ALPHA = 0.3;
const int SENSOR_WINDOW_SIZE = 5;
long distBuffer[SENSOR_WINDOW_SIZE] = {-1, -1, -1, -1, -1};
int distBufferIndex = 0;

long singlePulseCM() {
  digitalWrite(ULTRASONIC_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(ULTRASONIC_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(ULTRASONIC_TRIG, LOW);

  unsigned long duration = pulseIn(ULTRASONIC_ECHO, HIGH, 12000); 
  if (duration == 0) return -1;
  return (long)(duration * 0.034 / 2);
}

void sortArray(long arr[], int n) {
  for (int i = 1; i < n; i++) {
    long key = arr[i];
    int j = i - 1;
    while (j >= 0 && arr[j] > key) {
      arr[j + 1] = arr[j];
      j--;
    }
    arr[j + 1] = key;
  }
}

long readDistanceCM() {
  long d = singlePulseCM();
  distBuffer[distBufferIndex] = d;
  distBufferIndex = (distBufferIndex + 1) % SENSOR_WINDOW_SIZE;

  long validSamples[SENSOR_WINDOW_SIZE];
  int validCount = 0;
  for (int i = 0; i < SENSOR_WINDOW_SIZE; i++) {
    if (distBuffer[i] > 0 && distBuffer[i] <= 400) {
      validSamples[validCount++] = distBuffer[i];
    }
  }

  if (validCount == 0) return -1;

  sortArray(validSamples, validCount);
  long median = validSamples[validCount / 2];

  if (emaDistance < 0) {
    emaDistance = (float)median;
  } else {
    emaDistance = EMA_ALPHA * median + (1.0 - EMA_ALPHA) * emaDistance;
  }

  return (long)(emaDistance + 0.5);
}

void webSocketEvent(WStype_t type, uint8_t * payload, size_t length) {
  switch(type) {
    case WStype_DISCONNECTED:
      Serial.println("[WS] Disconnected from server!");
      wsConnected = false;
      break;
    case WStype_CONNECTED:
      Serial.printf("[WS] Connected to %s\n", payload);
      wsConnected = true;
      ledBlink(3, 100);
      break;
    case WStype_TEXT:
      Serial.printf("[WS] Received msg: %s\n", payload);
      break;
    default:
      break;
  }
}

void setup() {
  Serial.begin(115200);
  Serial.println("\nStarting ESP32 Mic + Sensors...");

  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password);
  
  pinMode(LED_PIN, OUTPUT);
  ledOff();

  i2s_config_t i2s_config = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
    .sample_rate = 16000,
    .bits_per_sample = I2S_BITS_PER_SAMPLE_32BIT,
    .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
#if defined(I2S_COMM_FORMAT_STAND_I2S)
    .communication_format = I2S_COMM_FORMAT_STAND_I2S,
#else
    .communication_format = (i2s_comm_format_t)(I2S_COMM_FORMAT_I2S | I2S_COMM_FORMAT_I2S_MSB),
#endif
    .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
    .dma_buf_count = 16,
    .dma_buf_len = AUDIO_BUFFER_SAMPLES,
    .use_apll = false,
    .tx_desc_auto_clear = false,
    .fixed_mclk = 0
  };
  
  i2s_pin_config_t pin_config = {
    .bck_io_num = I2S_SCK,
    .ws_io_num = I2S_WS,
    .data_out_num = -1,
    .data_in_num = I2S_SD
  };
  
  i2s_driver_install(I2S_PORT, &i2s_config, 0, NULL);
  i2s_set_pin(I2S_PORT, &pin_config);
  i2s_zero_dma_buffer(I2S_PORT);

  pinMode(TOUCH_PIN, INPUT_PULLDOWN);
  pinMode(PIR_PIN, INPUT);          
  pinMode(ULTRASONIC_TRIG, OUTPUT);
  pinMode(ULTRASONIC_ECHO, INPUT); 

  webSocket.beginSSL(serverIp, serverPort, "/api/pi/ws");
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(5000);
}

void loop() {
  webSocket.loop();

  // WiFi Reconnection Logic
  if (WiFi.status() != WL_CONNECTED) {
    if (millis() - lastWiFiCheck >= 5000) {
      Serial.println("[WIFI] Disconnected. Reconnecting...");
      WiFi.disconnect();
      WiFi.reconnect();
      lastWiFiCheck = millis();
    }
    return;
  }

  // Periodic memory log
  if (millis() - lastHeapLog > 30000) {
    lastHeapLog = millis();
    Serial.printf("[MEM] Free heap: %u bytes\n", ESP.getFreeHeap());
  }
  
  // Guard against recording while disconnected
  if (isRecording && !wsConnected) {
    isRecording = false;
    ledOff();
    Serial.println("[PTT] WS disconnected! Stopping recording.");
  }

  // ─── SENSOR TELEMETRY ───
  if (!isRecording && (millis() - lastSensorSend >= currentSensorInterval)) {
    lastSensorSend = millis();
    int pirState = digitalRead(PIR_PIN);       
    long distanceCM = readDistanceCM();         
    
    if (wsConnected) {
      bool isAlert = (pirState == 1) || (distanceCM > 0 && distanceCM < 100);
      currentSensorInterval = isAlert ? ALERT_INTERVAL : IDLE_INTERVAL;
      const char* mode = isAlert ? "ALERT" : "IDLE";
      
      char sensorJSON[128];
      snprintf(sensorJSON, sizeof(sensorJSON), "{\"type\":\"sensors\",\"p\":%d,\"u\":%ld,\"mode\":\"%s\"}", 
               pirState, distanceCM, mode);
      webSocket.sendTXT(sensorJSON);
    }
  }

  // ─── PUSH-TO-TALK DEBOUNCED LOGIC ───
  bool reading = digitalRead(TOUCH_PIN);
  if (reading != lastButtonState) {
    lastDebounceTime = millis();
  }

  if ((millis() - lastDebounceTime) > DEBOUNCE_DELAY) {
    if (reading != buttonState) {
      buttonState = reading;
      
      if (buttonState == HIGH) {
        // BUTTON PRESSED - START
        if (wsConnected) {
          Serial.println("[PTT] Button pressed! Starting...");
          ledOn();
          webSocket.sendTXT("START");
          isRecording = true;
          i2s_zero_dma_buffer(I2S_PORT);
        } else {
          Serial.println("[ERR] WS not connected, cannot stream.");
        }
      } else {
        // BUTTON RELEASED - STOP
        if (isRecording) {
          Serial.println("[PTT] Released! Stopping...");
          ledOff();
          webSocket.sendTXT("STOP");
          isRecording = false;
        }
      }
    }
  }
  lastButtonState = reading;

  // ─── REAL-TIME AUDIO STREAMING ───
  if (isRecording) {
    size_t bytesRead = 0;
    esp_err_t result = i2s_read(I2S_PORT, pcm32Buffer, sizeof(pcm32Buffer), &bytesRead, 100 / portTICK_PERIOD_MS);

    if (result == ESP_OK && bytesRead > 0) {
      int samplesRead = bytesRead / 4; 
      int32_t* ptr32 = (int32_t*)pcm32Buffer;
      const int NOISE_GATE_THRESHOLD = 200; 

      for(int i = 0; i < samplesRead; i++) {
        int32_t sample = ptr32[i] >> 15; 
        if (sample > 32767) sample = 32767;
        else if (sample < -32768) sample = -32768;
        
        int16_t sample16 = (int16_t)sample;
        if (abs(sample16) < NOISE_GATE_THRESHOLD) {
            sample16 = 0;
        }
        pcm16Buffer[i] = sample16;
      }
      
      int bytesToSend = samplesRead * 2;
      webSocket.sendBIN((uint8_t*)pcm16Buffer, bytesToSend);
    }
  }
}