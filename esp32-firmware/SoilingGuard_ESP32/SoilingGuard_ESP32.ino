/*
 * SoilingGuard ESP32 firmware
 * ---------------------------------------------------------------------------
 * Solar panel soiling monitor + cleaning actuator for Arduino IDE.
 *
 * The board measures the panel electrically (INA219), the relative light level
 * (LDR), and the panel temperature (DS18B20), publishes those measurements to
 * the SoilingGuard backend, reads the latest visual AI classification, follows
 * START/STOP commands issued from the dashboard, and can request its own
 * cleaning cycle when the onboard decision engine is convinced the panel is
 * dirty. Every cleaning cycle is verified with a before/after power comparison.
 *
 * Everything reported as a measurement is really measured. When a sensor is
 * missing or returns an implausible value the field is simply not sent (the
 * backend stores NULL) and the dashboard shows "unavailable" - the firmware
 * never fabricates a reading.
 *
 * Required libraries (Library Manager):
 *   - Adafruit INA219                 (>= 1.2.3)
 *   - OneWire                         (>= 2.3.8)
 *   - DallasTemperature               (>= 3.9.1)
 *   - ArduinoJson                     (>= 7.0.0, v6 is NOT supported)
 *
 * Board: "ESP32 Dev Module" (or your DevKit V1 equivalent), 115200 baud.
 *
 * Wiring, calibration, API contract, factory tests and troubleshooting are in
 * README.md next to this file. Read it before powering the motor.
 *
 * SAFETY: this sketch drives a real motor that moves a cleaning mechanism over
 * a panel. It is a prototype, not a certified safety device. Provide a
 * physical emergency stop and never leave a moving mechanism unattended.
 * ---------------------------------------------------------------------------
 */

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <Adafruit_INA219.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <Preferences.h>
#include <time.h>
#include <math.h>

#if !defined(ARDUINOJSON_VERSION_MAJOR) || ARDUINOJSON_VERSION_MAJOR < 7
#error "Install ArduinoJson 7.x (Library Manager). This sketch uses JsonDocument."
#endif

// ===========================================================================
// 1. User configuration
// ===========================================================================

// --- Wi-Fi -----------------------------------------------------------------
const char *const WIFI_SSID = "YOUR_WIFI_NAME";
const char *const WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// --- Backend ---------------------------------------------------------------
// LAN example:   "http://192.168.1.50:8000"
// Render (TLS):  "https://soilingguard-pv-soiling-cleaning.onrender.com"
// HTTPS is supported through WiFiClientSecure.setInsecure() (no certificate
// pinning). For production, pin the CA instead - see README "TLS".
const char *const API_BASE = "http://192.168.1.50:8000";
const char *const DEVICE_ID = "PV-ESP32-01";
const char *const DEVICE_API_KEY = "soilingguard-esp32-key"; // backend IOT_DEVICE_KEY
const char *const FW_VERSION = "1.0.0";

// --- Pins (ESP32 DevKit V1) ------------------------------------------------
#define PIN_I2C_SDA 21
#define PIN_I2C_SCL 22
#define PIN_LDR 34        // input-only, ADC1: safe while Wi-Fi is on
#define PIN_DS18B20 4
#define PIN_MOTOR_IN1 26
#define PIN_MOTOR_IN2 27
#define PIN_MOTOR_ENA 25
#define PIN_STATUS_LED 2  // onboard LED (strapping pin: do not drive HIGH at boot)

// --- Hardware ratings / calibration ---------------------------------------
#define PANEL_RATED_W 100.0f      // nameplate power of the panel being watched
#define INA219_MAX_AMPS 2.0f      // 32V/2A shunt calibration; do not exceed
#define LDR_ADC_DARK 200.0f       // raw ADC seen with the LDR fully covered
#define LDR_ADC_BRIGHT 3400.0f    // raw ADC seen with the LDR in direct sun
#define TEMP_COEFF_PER_C 0.004f   // panel power coefficient (per degC above 25C)
#define TEMP_REFERENCE_C 25.0f

// --- Behaviour -------------------------------------------------------------
#define DRY_RUN false             // true = full logic, motor pins stay LOW
#define ALLOW_DEMO_AI false       // true = accept demo/labelled AI results
#define DEFAULT_SPEED_PCT 60      // motor duty used unless the server says otherwise
#define MAX_CLEAN_SECONDS 120     // hard cap, independent of the server command
#define DEFAULT_CLEAN_SECONDS 45
#define SETTLE_SECONDS 10         // wait after the motor stops before measuring
#define MIN_CLEAN_INTERVAL_S 600  // local guard against repeated self-requests
#define MIN_CLEAN_CONF 0.75f
#define BIRD_CONF 0.85f
#define MIN_CLEAN_LIGHT_PCT 30.0f // below this the AI image is unreliable anyway
#define MAX_CLEAN_TEMP_C 60.0f
#define NIGHT_LIGHT_PCT 3.0f
#define SOILING_TRIGGER_PCT 15.0f
#define SOILING_ALARM_PCT 30.0f
#define AI_MAX_AGE_S 300.0f

// --- Timing ----------------------------------------------------------------
#define TELEMETRY_INTERVAL_MS 15000UL
#define HEARTBEAT_INTERVAL_MS 30000UL
#define AI_INTERVAL_MS 60000UL
#define COMMAND_POLL_MS 5000UL
#define DECISION_INTERVAL_MS 30000UL
#define TEMP_SAMPLE_MS 2000UL
#define LIGHT_SAMPLE_MS 1000UL
#define WIFI_RETRY_MS 15000UL
#define HTTP_TIMEOUT_MS 4000UL
#define QUEUE_SIZE 12
#define QUEUE_MAX_AGE_S 3600UL

// PWM
#define MOTOR_PWM_FREQ 20000
#define MOTOR_PWM_RES 8
#define MOTOR_PWM_CHANNEL 0

// ===========================================================================
// 2. Globals
// ===========================================================================

Preferences prefs;
Adafruit_INA219 ina219;
OneWire oneWire(PIN_DS18B20);
DallasTemperature ds18b20(&oneWire);

WiFiClient plainClient;
WiFiClientSecure tlsClient;
HTTPClient http;

bool tlsMode = false;
bool wifiWasConnected = false;
uint32_t lastWifiAttempt = 0;

struct Sensors {
  bool electricalOk = false;
  bool lightOk = false;
  bool tempOk = false;
  float voltage = 0.0f;
  float current = 0.0f;
  float power = 0.0f;
  float lightPct = 0.0f;
  float tempC = NAN;
  float expectedW = 0.0f;
  float lossPct = NAN;
  uint32_t lightRaw = 0;
  uint32_t lightAtMs = 0;
} sensors;

bool tempPending = false;
uint32_t tempRequestedMs = 0;
uint32_t lastLightReadMs = 0;

struct Sample {
  uint32_t epoch;
  bool electricalOk;
  bool lightOk;
  bool tempOk;
  float voltage;
  float current;
  float power;
  float lightPct;
  float tempC;
  bool motorRunning;
};

Sample queueBuf[QUEUE_SIZE];
uint8_t queueHead = 0;
uint8_t queueCount = 0;

enum MotorState : uint8_t { MOTOR_IDLE, MOTOR_RUNNING, MOTOR_SETTLING };
MotorState motorState = MOTOR_IDLE;

struct Cycle {
  bool hasJob = false;
  String jobId;
  uint32_t startedMs = 0;
  uint32_t durationMs = 0;
  uint32_t settleStartMs = 0;
  float beforePower = 0.0f;
  float beforeLight = 0.0f;
  float beforeTemp = NAN;
  bool beforeValid = false;
  bool beforeTempValid = false;
} cycle;

bool everRan = false;
uint32_t lastCycleEndMs = 0;
uint32_t lastSelfRequestMs = 0;
bool autoMode = false;
bool estopLatched = false;
uint8_t motorSpeedPct = DEFAULT_SPEED_PCT;
String lastVerification = "none";

struct AiState {
  bool available = false;
  bool fresh = false;
  bool demo = false;
  String cls = "clean";
  float conf = 0.0f;
  float pClean = 0.0f;
  float pLight = 0.0f;
  float pHeavy = 0.0f;
  float pBird = 0.0f;
  String recommendation;
  float ageS = 99999.0f;
  uint32_t fetchedMs = 0;
} ai;

uint32_t lastTelemetryMs = 0;
uint32_t lastHeartbeatMs = 0;
uint32_t lastAiMs = 0;
uint32_t lastCommandPollMs = 0;
uint32_t lastDecisionMs = 0;
uint32_t lastLedMs = 0;
bool ledOn = false;
uint32_t bootMs = 0;

String serialBuf;
bool serialOverflow = false;

// ===========================================================================
// 3. Small helpers
// ===========================================================================

static float clampf(float v, float lo, float hi) {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

static bool elapsed(uint32_t sinceMs, uint32_t intervalMs) {
  return (uint32_t)(millis() - sinceMs) >= intervalMs;
}

static uint32_t epochNow() {
  time_t t = time(nullptr);
  if (t < 1700000000) return 0; // clock not synced yet
  return (uint32_t)t;
}

static void ledWrite(bool on) {
  digitalWrite(PIN_STATUS_LED, on ? HIGH : LOW);
  ledOn = on;
}

// ===========================================================================
// 4. Preferences (E-STOP latch and operator choices survive reboots)
// ===========================================================================

static void loadPrefs() {
  prefs.begin("soilingguard", false);
  estopLatched = prefs.getBool("estop", false);
  autoMode = prefs.getBool("auto", false);
  motorSpeedPct = (uint8_t)clampf((float)prefs.getUChar("speed", DEFAULT_SPEED_PCT), 10, 100);
}

static void saveEstop() { prefs.putBool("estop", estopLatched); }
static void saveAuto() { prefs.putBool("auto", autoMode); }
static void saveSpeed() { prefs.putUChar("speed", motorSpeedPct); }

// ===========================================================================
// 5. Motor control (non-blocking; safe defaults)
// ===========================================================================

static void motorOutputsLow() {
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcWrite(PIN_MOTOR_ENA, 0);
#else
  ledcWrite(MOTOR_PWM_CHANNEL, 0);
#endif
  digitalWrite(PIN_MOTOR_IN1, LOW);
  digitalWrite(PIN_MOTOR_IN2, LOW);
}

static void setupMotor() {
  pinMode(PIN_MOTOR_IN1, OUTPUT);
  pinMode(PIN_MOTOR_IN2, OUTPUT);
  digitalWrite(PIN_MOTOR_IN1, LOW);
  digitalWrite(PIN_MOTOR_IN2, LOW);

#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcAttach(PIN_MOTOR_ENA, MOTOR_PWM_FREQ, MOTOR_PWM_RES);
  ledcWrite(PIN_MOTOR_ENA, 0);
#else
  ledcSetup(MOTOR_PWM_CHANNEL, MOTOR_PWM_FREQ, MOTOR_PWM_RES);
  ledcAttachPin(PIN_MOTOR_ENA, MOTOR_PWM_CHANNEL);
  ledcWrite(MOTOR_PWM_CHANNEL, 0);
#endif
}

static void motorDrive(uint8_t pct) {
  if (DRY_RUN) {
    Serial.println("[motor] DRY_RUN: outputs suppressed");
    return;
  }
  uint8_t duty = (uint8_t)((uint16_t)clampf((float)pct, 0, 100) * 255 / 100);
  digitalWrite(PIN_MOTOR_IN1, HIGH);
  digitalWrite(PIN_MOTOR_IN2, LOW);
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcWrite(PIN_MOTOR_ENA, duty);
#else
  ledcWrite(MOTOR_PWM_CHANNEL, duty);
#endif
}

// ===========================================================================
// 6. Sensors
// ===========================================================================

static void setupSensors() {
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);

  if (ina219.begin()) {
    ina219.setCalibration_32V_2A();
    Serial.println("[ina219] ready (32V / 2A calibration)");
  } else {
    Serial.println("[ina219] NOT FOUND - electrical values will be reported as unavailable");
  }

  ds18b20.begin();
  ds18b20.setResolution(11); // ~375 ms conversion, good compromise
  Serial.printf("[ds18b20] %d device(s) on the bus\n", ds18b20.getDeviceCount());

  analogReadResolution(12);
  analogSetPinAttenuation(PIN_LDR, ADC_11db);
}

static void readElectrical() {
  sensors.electricalOk = false;
  if (isnan(ina219.getBusVoltage_V())) return;

  float volts = ina219.getBusVoltage_V();
  float amps = ina219.getCurrent_mA() / 1000.0f;
  float watts = ina219.getPower_mW() / 1000.0f;

  // Reject implausible values (loose shunt, floating I2C) instead of storing them.
  if (volts < 0.0f || volts > 32.0f || fabsf(amps) > (INA219_MAX_AMPS * 1.05f)) {
    return;
  }

  sensors.voltage = volts;
  sensors.current = amps;
  sensors.power = (watts < 0.0f) ? 0.0f : watts;
  sensors.electricalOk = true;
}

static void readLight() {
  uint32_t acc = 0;
  for (int i = 0; i < 8; i++) acc += (uint32_t)analogRead(PIN_LDR);
  uint32_t raw = acc / 8;

  float span = LDR_ADC_BRIGHT - LDR_ADC_DARK;
  if (fabsf(span) < 50.0f) {
    sensors.lightOk = false;
    return;
  }

  // Works for both divider orientations because DARK/BRIGHT are calibrated
  // values, not assumed ones. Clamped, so a mis-wired LDR reads 0% (safe).
  float pct = 100.0f * ((float)raw - LDR_ADC_DARK) / span;
  pct = clampf(pct, 0.0f, 100.0f);

  if (sensors.lightOk) {
    sensors.lightPct = sensors.lightPct * 0.7f + pct * 0.3f; // light smoothing
  } else {
    sensors.lightPct = pct;
  }
  sensors.lightOk = true;
  sensors.lightRaw = raw;
  sensors.lightAtMs = millis();
  lastLightReadMs = millis();
}

// DS18B20 conversions are asynchronous: request, then read on a later pass,
// so the motor timing and command polling are never blocked for 375 ms.
static void serviceTemperature() {
  if (!tempPending) {
    ds18b20.requestTemperatures();
    tempPending = true;
    tempRequestedMs = millis();
    return;
  }
  if (!elapsed(tempRequestedMs, 800)) return;

  tempPending = false;
  float t = ds18b20.getTempCByIndex(0);
  if (t == DEVICE_DISCONNECTED_C || t < -40.0f || t > 125.0f) {
    sensors.tempOk = false;
    sensors.tempC = NAN;
    return;
  }
  // Panel temperature proxy: the probe is bonded to the back sheet.
  sensors.tempOk = true;
  sensors.tempC = t;
}

static void computeDerived() {
  if (sensors.tempOk) {
    float derate = 1.0f - TEMP_COEFF_PER_C * (sensors.tempC - TEMP_REFERENCE_C);
    derate = clampf(derate, 0.5f, 1.05f);
    sensors.expectedW = PANEL_RATED_W * (sensors.lightPct / 100.0f) * derate;
  } else {
    sensors.expectedW = PANEL_RATED_W * (sensors.lightPct / 100.0f);
  }

  // A relative-light baseline can never be an absolute irradiance measurement,
  // so the "loss" is only used for gating and warnings, never for reporting.
  if (sensors.electricalOk && sensors.lightOk && sensors.expectedW >= 5.0f &&
      sensors.lightPct >= 10.0f) {
    float loss = (sensors.expectedW - sensors.power) / sensors.expectedW * 100.0f;
    sensors.lossPct = clampf(loss, 0.0f, 100.0f);
  } else {
    sensors.lossPct = NAN;
  }
}

static void sampleSensors() {
  readElectrical();
  computeDerived();
}

// ===========================================================================
// 7. Wi-Fi (state machine, never blocks)
// ===========================================================================

static void setupWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.persistent(false);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  lastWifiAttempt = millis();
  Serial.printf("[wifi] connecting to %s\n", WIFI_SSID);
}

static void serviceWifi() {
  if (WiFi.status() == WL_CONNECTED) {
    if (!wifiWasConnected) {
      wifiWasConnected = true;
      Serial.printf("[wifi] connected, ip=%s rssi=%d\n",
                    WiFi.localIP().toString().c_str(), WiFi.RSSI());
      configTime(0, 0, "pool.ntp.org", "time.google.com");
    }
    return;
  }

  if (wifiWasConnected) {
    wifiWasConnected = false;
    Serial.println("[wifi] link lost - retrying in background");
  }
  if (elapsed(lastWifiAttempt, WIFI_RETRY_MS)) {
    lastWifiAttempt = millis();
    WiFi.disconnect();
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    Serial.println("[wifi] retry");
  }
}

static bool wifiOnline() { return WiFi.status() == WL_CONNECTED; }

// ===========================================================================
// 8. HTTP / JSON plumbing
// ===========================================================================

// Returns the HTTP status code, or a negative value on transport failure.
// When outDoc != nullptr the JSON body is parsed into it (v7: clears it first).
static int apiCall(const char *method, const String &path, const String &body,
                   JsonDocument *outDoc, String *rawOut = nullptr) {
  if (!wifiOnline()) return -1;

  String url = String(API_BASE);
  if (url.endsWith("/")) url.remove(url.length() - 1);
  url += path;

  http.setTimeout(HTTP_TIMEOUT_MS);
  http.setReuse(false);

  bool began = tlsMode ? http.begin(tlsClient, url) : http.begin(plainClient, url);
  if (!began) {
    http.end();
    return -2;
  }

  http.addHeader("X-Device-Key", DEVICE_API_KEY);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Accept", "application/json");

  int code;
  if (strcmp(method, "GET") == 0) {
    code = http.GET();
  } else {
    code = http.POST(body);
  }

  String payload;
  if (code > 0) payload = http.getString();
  http.end();

  if (rawOut) *rawOut = payload;

  if (outDoc) {
    outDoc->clear();
    if (payload.length() > 0) {
      DeserializationError err = deserializeJson(*outDoc, payload);
      if (err) {
        Serial.printf("[http] %s %s -> %d, JSON error: %s\n", method, path.c_str(), code,
                      err.c_str());
      }
    }
  }

  if (code <= 0 || code >= 400) {
    String shortPayload = payload.substring(0, 180);
    Serial.printf("[http] %s %s -> %d %s\n", method, path.c_str(), code, shortPayload.c_str());
  }
  return code;
}

// ===========================================================================
// 9. Telemetry upload + offline queue
// ===========================================================================

static Sample currentSample() {
  Sample s;
  s.epoch = epochNow();
  s.electricalOk = sensors.electricalOk;
  s.lightOk = sensors.lightOk;
  s.tempOk = sensors.tempOk;
  s.voltage = sensors.voltage;
  s.current = sensors.current;
  s.power = sensors.power;
  s.lightPct = sensors.lightPct;
  s.tempC = sensors.tempC;
  s.motorRunning = (motorState == MOTOR_RUNNING);
  return s;
}

static bool postSample(const Sample &s) {
  JsonDocument doc;
  doc["device_id"] = DEVICE_ID;
  if (s.epoch > 0) doc["timestamp"] = s.epoch;
  // Only real measurements are sent; omitted keys become NULL in the database.
  if (s.electricalOk) {
    doc["voltage"] = s.voltage;
    doc["current"] = s.current;
    doc["power"] = s.power;
  }
  if (s.lightOk) doc["light_level"] = roundf(s.lightPct * 10.0f) / 10.0f;
  if (s.tempOk) doc["temperature"] = roundf(s.tempC * 10.0f) / 10.0f;
  doc["motor_status"] = s.motorRunning ? "running" : "stopped";
  doc["wifi_status"] = wifiOnline() ? "connected" : "disconnected";
  if (wifiOnline()) doc["wifi_rssi"] = WiFi.RSSI();
  doc["firmware_version"] = FW_VERSION;

  bool complete = s.electricalOk && s.lightOk && s.tempOk;
  doc["quality"] = complete ? "good" : "missing";

  String body;
  serializeJson(doc, body);

  int code = apiCall("POST", "/api/telemetry", body, nullptr);
  if (code >= 200 && code < 300) return true;

  // Keep the sample and retry when the link is back.
  if (queueCount < QUEUE_SIZE) {
    queueBuf[(queueHead + queueCount) % QUEUE_SIZE] = s;
    queueCount++;
    Serial.printf("[queue] telemetry buffered (%u/%u)\n", queueCount, QUEUE_SIZE);
  } else {
    Serial.println("[queue] full, oldest sample dropped");
    queueBuf[queueHead] = s;
    queueHead = (queueHead + 1) % QUEUE_SIZE;
  }
  return false;
}

static void flushQueue() {
  static uint32_t lastFlushMs = 0;
  if (!wifiOnline() || queueCount == 0) return;
  if (!elapsed(lastFlushMs, 1500)) return; // avoid a burst after reconnect
  lastFlushMs = millis();

  Sample s = queueBuf[queueHead];
  queueHead = (queueHead + 1) % QUEUE_SIZE;
  queueCount--;

  uint32_t now = epochNow();
  if (now > 0 && s.epoch > 0 && now - s.epoch > QUEUE_MAX_AGE_S) {
    Serial.println("[queue] dropped a stale buffered sample");
    return;
  }
  if (!postSample(s)) {
    Serial.println("[queue] flush failed, will retry");
  }
}

static void sendTelemetry() {
  postSample(currentSample());
}

static void sendHeartbeat() {
  JsonDocument doc;
  doc["device_id"] = DEVICE_ID;
  doc["online"] = true;
  doc["firmware_version"] = FW_VERSION;
  doc["wifi_connected"] = wifiOnline();
  if (wifiOnline()) doc["wifi_rssi"] = WiFi.RSSI();
  doc["sensors"]["ina219"] = sensors.electricalOk;
  doc["sensors"]["ldr"] = sensors.lightOk;
  doc["sensors"]["ds18b20"] = sensors.tempOk;
  doc["motor_status"] = motorState == MOTOR_RUNNING ? "running" : "stopped";
  doc["free_heap"] = ESP.getFreeHeap();

  String body;
  serializeJson(doc, body);
  apiCall("POST", "/api/device/status", body, nullptr);
}

// ===========================================================================
// 10. AI classification
// ===========================================================================

static void fetchAi() {
  JsonDocument doc;
  int code = apiCall("GET", String("/api/ai/latest?device_id=") + DEVICE_ID, "", &doc);
  if (code != 200) {
    ai.available = false;
    ai.fresh = false;
    if (code == 404) {
      Serial.println("[ai] no visual classification stored yet");
    }
    return;
  }

  ai.available = true;
  ai.cls = String((const char *)(doc["predicted_class"] | "clean"));
  ai.conf = doc["confidence"] | 0.0f;
  ai.pClean = doc["probabilities"]["clean"] | 0.0f;
  ai.pLight = doc["probabilities"]["light_dust"] | 0.0f;
  ai.pHeavy = doc["probabilities"]["heavy_dust"] | 0.0f;
  ai.pBird = doc["probabilities"]["bird_dropping"] | 0.0f;
  ai.recommendation = String((const char *)(doc["recommendation"] | ""));
  ai.demo = doc["demo"] | false;
  ai.ageS = doc["age_s"] | 99999.0f;
  ai.fetchedMs = millis();
  ai.fresh = ai.ageS <= AI_MAX_AGE_S;

  Serial.printf("[ai] %s conf=%.2f demo=%s age=%.0fs\n", ai.cls.c_str(), ai.conf,
                ai.demo ? "yes" : "no", ai.ageS);
}

// ===========================================================================
// 11. Cleaning cycles
// ===========================================================================

static void captureBaseline() {
  readElectrical();
  computeDerived();
  cycle.beforePower = sensors.power;
  cycle.beforeLight = sensors.lightPct;
  cycle.beforeTemp = sensors.tempC;
  cycle.beforeValid = sensors.electricalOk && sensors.lightOk && sensors.power > 0.5f;
  cycle.beforeTempValid = sensors.tempOk;
}

static void postResult(const char *status, const char *outcome, const String &note,
                       bool includePower, float powerBefore, float powerAfter,
                       uint32_t durationS) {
  JsonDocument doc;
  if (cycle.hasJob) doc["job_id"] = cycle.jobId;
  doc["device_id"] = DEVICE_ID;
  doc["status"] = status;
  doc["duration_s"] = (float)durationS;
  if (includePower) {
    doc["power_before"] = roundf(powerBefore * 100.0f) / 100.0f;
    doc["power_after"] = roundf(powerAfter * 100.0f) / 100.0f;
  }
  if (outcome && outcome[0]) doc["outcome"] = outcome;
  if (note.length() > 0) doc["note"] = note.substring(0, 200);

  String body;
  serializeJson(doc, body);

  if (!cycle.hasJob) {
    Serial.println("[cycle] local cycle (no dashboard job): result kept in the log only");
    return;
  }
  apiCall("POST", "/api/cleaning/result", body, nullptr);
}

static void startCycle(uint32_t durationS, uint8_t speedPct, const String &jobId) {
  if (estopLatched || motorState != MOTOR_IDLE) {
    Serial.println("[cycle] refused: e-stop latched or motor busy");
    return;
  }

  cycle.hasJob = jobId.length() > 0;
  cycle.jobId = jobId;
  cycle.startedMs = millis();
  cycle.durationMs = (uint32_t)clampf((float)durationS, 5.0f, (float)MAX_CLEAN_SECONDS) * 1000UL;
  captureBaseline();

  motorState = MOTOR_RUNNING;
  motorDrive(speedPct);
  Serial.printf("[cycle] START %s %lus at %u%% (before: %.2f W, light %.0f%%, temp %s)\n",
                cycle.hasJob ? cycle.jobId.c_str() : "(local)", (unsigned long)(cycle.durationMs / 1000UL),
                (unsigned)speedPct, cycle.beforePower, cycle.beforeLight,
                cycle.beforeTempValid ? String(cycle.beforeTemp, 1).c_str() : "n/a");
}

static void finishCycle(const char *status, const char *outcome, const String &note,
                        uint32_t durationS) {
  motorOutputsLow();
  postResult(status, outcome, note, false, 0.0f, 0.0f, durationS);
  motorState = MOTOR_IDLE;
  everRan = true;
  lastCycleEndMs = millis();
  cycle.hasJob = false;
  cycle.jobId = "";
}

static void stopCycle(const char *status, const char *outcome, const String &note) {
  if (motorState == MOTOR_IDLE) return;
  uint32_t ranS = (millis() - cycle.startedMs) / 1000UL;
  Serial.printf("[cycle] stopping after %lus: %s\n", (unsigned long)ranS, outcome);
  finishCycle(status, outcome, note, ranS);
}

static void verifyCycle() {
  uint32_t ranS = (millis() - cycle.startedMs) / 1000UL;

  // Motor is already off; take a settled measurement.
  readElectrical();
  computeDerived();

  bool afterValid = sensors.electricalOk && sensors.lightOk && sensors.power > 0.5f;
  float afterPower = sensors.power;
  float afterLight = sensors.lightPct;
  float afterTemp = sensors.tempC;

  String why = "";
  bool comparable = true;
  if (!cycle.beforeValid) {
    comparable = false;
    why = "before measurement not valid";
  } else if (!afterValid) {
    comparable = false;
    why = "after measurement not valid";
  } else {
    float lightDelta = fabsf(afterLight - cycle.beforeLight);
    float lightLimit = fmaxf(5.0f, cycle.beforeLight * 0.15f);
    if (lightDelta > lightLimit) {
      comparable = false;
      why = "light changed by " + String(lightDelta, 1) + " points";
    } else if (cycle.beforeTempValid && sensors.tempOk &&
               fabsf(afterTemp - cycle.beforeTemp) > 3.0f) {
      comparable = false;
      why = "temperature changed by " + String(fabsf(afterTemp - cycle.beforeTemp), 1) + " C";
    }
  }

  if (!comparable) {
    if (why.length() == 0) why = "before/after measurement not valid";
    lastVerification = "unavailable (" + why + ")";
    Serial.printf("[cycle] verification unavailable: %s\n", why.c_str());
    finishCycle("completed", "verification_unavailable",
                "Power verification unavailable: " + why, ranS);
    return;
  }

  float improvement = (afterPower - cycle.beforePower) / cycle.beforePower * 100.0f;
  const char *outcome;
  if (improvement >= 5.0f) {
    outcome = "cleaning_successful";
  } else if (improvement <= -2.0f) {
    outcome = "degraded";
  } else {
    outcome = "no_significant_change";
  }

  lastVerification = String(improvement, 1) + "% (" + String(cycle.beforePower, 2) + " W -> " +
                      String(afterPower, 2) + " W)";
  Serial.printf("[cycle] verification: %.1f%% improvement (%s)\n", improvement, outcome);

  String note = String("light ") + String(cycle.beforeLight, 0) + "%->" + String(afterLight, 0) +
                "%, temp " +
                (cycle.beforeTempValid ? String(cycle.beforeTemp, 1) : String("n/a")) + "->" +
                (sensors.tempOk ? String(afterTemp, 1) : String("n/a")) + "C";

  motorOutputsLow();
  postResult("completed", outcome, note, true, cycle.beforePower, afterPower, ranS);
  motorState = MOTOR_IDLE;
  everRan = true;
  lastCycleEndMs = millis();
  cycle.hasJob = false;
  cycle.jobId = "";
}

static void serviceMotor() {
  if (estopLatched && motorState != MOTOR_IDLE) {
    stopCycle("stopped", "estop", "E-stop latched locally");
    return;
  }
  if (motorState == MOTOR_RUNNING) {
    if ((millis() - cycle.startedMs) >= cycle.durationMs) {
      motorOutputsLow();
      motorState = MOTOR_SETTLING;
      cycle.settleStartMs = millis();
      Serial.printf("[cycle] motor stopped, settling %us before verification\n",
                    (unsigned)SETTLE_SECONDS);
    }
    return;
  }
  if (motorState == MOTOR_SETTLING) {
    if (elapsed(cycle.settleStartMs, SETTLE_SECONDS * 1000UL)) {
      verifyCycle();
    }
  }
}

// ===========================================================================
// 12. Server commands
// ===========================================================================

static void pollCommand() {
  if (motorState != MOTOR_IDLE || estopLatched) return;

  JsonDocument doc;
  int code = apiCall("GET", String("/api/cleaning/command?device_id=") + DEVICE_ID, "", &doc);
  if (code != 200) return;

  String cmd = String((const char *)(doc["command"] | "NONE"));
  if (cmd == "NONE" || cmd.length() == 0) return;

  String jobId = String((const char *)(doc["job_id"] | ""));
  if (cmd == "START") {
    float duration = doc["duration_s"] | (float)DEFAULT_CLEAN_SECONDS;
    int speed = doc["speed_pct"] | (int)motorSpeedPct;
    startCycle((uint32_t)duration, (uint8_t)clampf((float)speed, 10, 100), jobId);
  } else if (cmd == "STOP") {
    stopCycle("stopped", "stop_requested", "STOP command received from dashboard");
  }
}

static void requestSelfCleaning(const String &reason) {
  JsonDocument doc;
  doc["device_id"] = DEVICE_ID;
  doc["reason"] = reason.substring(0, 200);
  if (!isnan(sensors.lossPct)) doc["soiling_pct"] = roundf(sensors.lossPct * 10.0f) / 10.0f;
  doc["predicted_class"] = ai.cls;
  doc["confidence"] = ai.conf;

  String body;
  serializeJson(doc, body);
  String raw;
  int code = apiCall("POST", "/api/cleaning/auto-request", body, nullptr, &raw);

  lastSelfRequestMs = millis();
  if (code >= 200 && code < 300) {
    Serial.println("[auto] cleaning authorised by the backend, waiting for START command");
  } else {
    Serial.printf("[auto] backend refused the request (HTTP %d)\n", code);
  }
}

// ===========================================================================
// 13. Onboard decision engine
// ===========================================================================
//
//  case 1  night / not enough light          -> no action
//  case 2  e-stop latched                    -> no action until RESET
//  case 3  AI unavailable / demo             -> no automatic action
//  case 4  AI says clean                     -> no action (warn if loss is high)
//  case 5  light dust                        -> monitor only
//  case 6  heavy dust / bird droppings       -> request cleaning if gates pass
//  case 7  recent cycle                      -> wait for the verification window
//
static void decisionEngine() {
  if (motorState != MOTOR_IDLE) return;

  // 2. Safety first.
  if (estopLatched) {
    Serial.println("[decide] case 2: E-STOP latched, reset required");
    return;
  }

  // 1. Night / unusable light.
  if (sensors.lightOk && sensors.lightPct < NIGHT_LIGHT_PCT) {
    Serial.println("[decide] case 1: night or insufficient light, no cleaning");
    return;
  }

  // 7. Cooldown / verification window.
  if (everRan && !elapsed(lastCycleEndMs, MIN_CLEAN_INTERVAL_S * 1000UL)) {
    Serial.printf("[decide] case 7: cooling down (%lus left), last result: %s\n",
                  (unsigned long)((MIN_CLEAN_INTERVAL_S * 1000UL - (millis() - lastCycleEndMs)) / 1000UL),
                  lastVerification.c_str());
    return;
  }

  // 3. AI availability.
  if (!ai.available || !ai.fresh) {
    Serial.println("[decide] case 3: no fresh AI result, recommend manual inspection");
    return;
  }
  if (ai.demo && !ALLOW_DEMO_AI) {
    Serial.println("[decide] case 3: AI result is a demo, automatic action disabled");
    return;
  }

  // 4. Clean.
  if (ai.cls == "clean") {
    if (!isnan(sensors.lossPct) && sensors.lossPct >= SOILING_ALARM_PCT) {
      Serial.printf("[decide] case 4: AI says clean but power loss is %.0f%%, check baseline/wiring\n",
                    sensors.lossPct);
    } else {
      Serial.println("[decide] case 4: panel clean, nothing to do");
    }
    return;
  }

  // 5. Light dust.
  if (ai.cls == "lightly_dusty" || ai.cls == "light_dust") {
    Serial.printf("[decide] case 5: light dust (%.0f%% conf), monitoring only\n", ai.conf * 100.0f);
    return;
  }

  // 6. Heavy dust / bird droppings.
  bool heavy = (ai.cls == "heavily_dusty" || ai.cls == "heavy_dust");
  bool bird = (ai.cls == "bird_dropping");
  if (!heavy && !bird) {
    Serial.printf("[decide] unknown class '%s', no action\n", ai.cls.c_str());
    return;
  }

  float requiredConf = bird ? BIRD_CONF : MIN_CLEAN_CONF;
  if (ai.conf < requiredConf) {
    Serial.printf("[decide] case 6: %s but confidence %.2f < %.2f, no action\n", ai.cls.c_str(),
                  ai.conf, requiredConf);
    return;
  }
  if (sensors.lightOk && sensors.lightPct < MIN_CLEAN_LIGHT_PCT) {
    Serial.printf("[decide] case 6: light %.0f%% is too low for a reliable cycle\n", sensors.lightPct);
    return;
  }
  if (sensors.tempOk && sensors.tempC > MAX_CLEAN_TEMP_C) {
    Serial.printf("[decide] case 6: panel at %.1f C is too hot\n", sensors.tempC);
    return;
  }
  if (!sensors.electricalOk) {
    Serial.println("[decide] case 6: electrical sensor unavailable, cannot verify a cycle");
    return;
  }
  if (!isnan(sensors.lossPct) && sensors.lossPct < SOILING_TRIGGER_PCT) {
    Serial.printf("[decide] case 6: measured loss only %.0f%%, waiting\n", sensors.lossPct);
    return;
  }

  if (!autoMode) {
    Serial.println("[decide] case 6: cleaning recommended but AUTO is off (send 'AUTO ON')");
    return;
  }
  if (elapsed(lastSelfRequestMs, MIN_CLEAN_INTERVAL_S * 1000UL)) {
    Serial.printf("[decide] case 6: %s at %.0f%% confidence, requesting a cleaning cycle\n",
                  ai.cls.c_str(), ai.conf * 100.0f);
    requestSelfCleaning(String("Onboard decision: ") + ai.cls + " " + String(ai.conf, 2) +
                        (bird ? " (bird droppings may also need manual removal)" : ""));
  }
}

// ===========================================================================
// 14. Serial console
// ===========================================================================

static void printHelp() {
  Serial.println();
  Serial.println("SoilingGuard ESP32 - serial commands");
  Serial.println("  HELP              this text");
  Serial.println("  STATUS            system, network, AI and cycle state");
  Serial.println("  READ              live sensor values (raw light included)");
  Serial.println("  CAL               raw LDR ADC value (use for LDR_ADC_DARK/BRIGHT)");
  Serial.println("  START [s] [pct]   start a local cleaning cycle now");
  Serial.println("  STOP              stop the running cycle");
  Serial.println("  ESTOP             latch emergency stop (persists across reboots)");
  Serial.println("  RESET             clear the E-STOP latch");
  Serial.println("  AUTO ON|OFF       enable/disable onboard automatic cleaning");
  Serial.println("  SPEED <10-100>    set motor duty for local cycles");
  Serial.println("  QUEUE             show offline telemetry queue length");
  Serial.println();
}

static void printStatus() {
  Serial.println();
  Serial.printf("firmware      %s  uptime %lus  heap %u\n", FW_VERSION,
                (unsigned long)((millis() - bootMs) / 1000UL), ESP.getFreeHeap());
  Serial.printf("wifi          %s  ip=%s  rssi=%d\n", wifiOnline() ? "online" : "offline",
                WiFi.localIP().toString().c_str(), WiFi.RSSI());
  Serial.printf("sensors       ina219=%s ldr=%s ds18b20=%s\n",
                sensors.electricalOk ? "ok" : "fault", sensors.lightOk ? "ok" : "fault",
                sensors.tempOk ? "ok" : "fault");
  Serial.printf("motor         %s  speed=%u%%  estop=%s  auto=%s\n",
                motorState == MOTOR_RUNNING ? "running"
                                            : (motorState == MOTOR_SETTLING ? "settling" : "idle"),
                (unsigned)motorSpeedPct, estopLatched ? "LATCHED" : "clear",
                autoMode ? "on" : "off");
  Serial.printf("verification  %s\n", lastVerification.c_str());
  Serial.printf("ai            %s  class=%s conf=%.2f demo=%s age=%.0fs\n",
                ai.available ? "available" : "none", ai.cls.c_str(), ai.conf,
                ai.demo ? "yes" : "no", ai.ageS);
  Serial.printf("queue         %u/%u\n", queueCount, QUEUE_SIZE);
}

static void handleCommand(String line) {
  line.trim();
  if (!line.length()) return;

  String upper = line;
  upper.toUpperCase();

  if (upper == "HELP") {
    printHelp();
  } else if (upper == "STATUS") {
    printStatus();
  } else if (upper == "READ") {
    readElectrical();
    readLight();
    computeDerived();
    Serial.printf("voltage=%.2f V  current=%.2f A  power=%.2f W  light=%.1f%% (raw %u)  "
                  "temp=%s  expected=%.2f W  loss=%s\n",
                  sensors.voltage, sensors.current, sensors.power, sensors.lightPct,
                  (unsigned)sensors.lightRaw,
                  sensors.tempOk ? String(sensors.tempC, 1).c_str() : "n/a", sensors.expectedW,
                  isnan(sensors.lossPct) ? "n/a" : String(sensors.lossPct, 1).c_str());
  } else if (upper == "CAL") {
    readLight();
    Serial.printf("raw LDR ADC = %u  (map to LDR_ADC_DARK / LDR_ADC_BRIGHT in the sketch)\n",
                  (unsigned)sensors.lightRaw);
  } else if (upper.startsWith("START")) {
    unsigned long durationS = DEFAULT_CLEAN_SECONDS;
    unsigned speedPct = motorSpeedPct;
    sscanf(line.c_str(), "%*s %lu %u", &durationS, &speedPct);
    if (speedPct < 10) speedPct = 10;
    if (speedPct > 100) speedPct = 100;
    Serial.println("[cmd] local START received");
    startCycle((uint32_t)durationS, (uint8_t)speedPct, "");
  } else if (upper == "STOP") {
    stopCycle("stopped", "serial_stop", "Stopped from the serial console");
  } else if (upper == "ESTOP") {
    estopLatched = true;
    saveEstop();
    motorOutputsLow();
    if (motorState != MOTOR_IDLE) stopCycle("stopped", "estop", "Local E-STOP");
    Serial.println("[cmd] E-STOP LATCHED - send RESET to clear");
  } else if (upper == "RESET") {
    estopLatched = false;
    saveEstop();
    Serial.println("[cmd] E-STOP latch cleared");
  } else if (upper.startsWith("AUTO")) {
    String arg = upper.substring(4);
    arg.trim();
    if (arg == "ON") {
      autoMode = true;
      saveAuto();
      Serial.println("[cmd] automatic cleaning ENABLED");
    } else if (arg == "OFF") {
      autoMode = false;
      saveAuto();
      Serial.println("[cmd] automatic cleaning DISABLED");
    } else {
      Serial.println("[cmd] usage: AUTO ON|OFF");
    }
  } else if (upper.startsWith("SPEED")) {
    int pct = upper.substring(5).toInt();
    if (pct < 10) pct = 10;
    if (pct > 100) pct = 100;
    motorSpeedPct = (uint8_t)pct;
    saveSpeed();
    Serial.printf("[cmd] speed set to %u%%\n", (unsigned)motorSpeedPct);
  } else if (upper == "QUEUE") {
    Serial.printf("[cmd] %u/%u samples buffered\n", queueCount, QUEUE_SIZE);
  } else {
    Serial.println("[cmd] unknown command, send HELP");
  }
}

static void serviceSerial() {
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\r') continue;
    if (c == '\n') {
      if (!serialOverflow) handleCommand(serialBuf);
      serialBuf = "";
      serialOverflow = false;
      continue;
    }
    if (serialBuf.length() < 80) {
      serialBuf += c;
    } else {
      serialOverflow = true;
    }
  }
}

// ===========================================================================
// 15. Status LED (non-blocking patterns)
// ===========================================================================

static void serviceLed() {
  uint32_t period;
  if (estopLatched) {
    period = 100; // fast blink: fault
  } else if (motorState == MOTOR_RUNNING) {
    period = 0; // steady on
  } else if (!wifiOnline()) {
    period = 500; // slow blink: no network
  } else {
    period = 2000; // heartbeat
  }

  if (period == 0) {
    if (!ledOn) ledWrite(true);
    return;
  }
  if (elapsed(lastLedMs, period)) {
    lastLedMs = millis();
    ledWrite(!ledOn);
  }
}

// ===========================================================================
// 16. setup / loop
// ===========================================================================

void setup() {
  bootMs = millis();
  Serial.begin(115200);
  delay(200); // USB CDC settle time on some boards

  Serial.println();
  Serial.println("==============================================");
  Serial.println(" SoilingGuard ESP32 firmware " FW_VERSION);
  Serial.println(" Measured data only - no fabricated readings");
  Serial.println("==============================================");

  pinMode(PIN_STATUS_LED, OUTPUT);
  ledWrite(false); // GPIO2 is a strapping pin: keep it LOW while booting

  setupMotor();
  loadPrefs();

  if (estopLatched) {
    Serial.println("[boot] E-STOP LATCHED from previous session - motors stay off");
  } else if (motorState == MOTOR_IDLE) {
    Serial.println("[boot] motors off, no cycle scheduled");
  }

  setupSensors();

  tlsMode = String(API_BASE).startsWith("https://");
  if (tlsMode) {
    tlsClient.setInsecure(); // see README "TLS": pin a CA for production
    Serial.println("[net] HTTPS mode (certificate validation disabled)");
  }

  setupWifi();

  lastLightReadMs = millis();
  readLight();
  delay(50);
  readElectrical();
  computeDerived();

  printHelp();
  Serial.printf("[boot] device %s -> %s\n", DEVICE_ID, API_BASE);
}

void loop() {
  serviceSerial();
  serviceWifi();

  if (elapsed(lastLightReadMs, LIGHT_SAMPLE_MS)) readLight();
  serviceTemperature();
  serviceMotor();
  serviceLed();

  static uint32_t lastSampleMs = 0;
  if (elapsed(lastSampleMs, 500)) {
    lastSampleMs = millis();
    sampleSensors();
  }

  if (wifiOnline()) {
    flushQueue();
    if (elapsed(lastTelemetryMs, TELEMETRY_INTERVAL_MS)) {
      lastTelemetryMs = millis();
      sendTelemetry();
    }
    if (elapsed(lastHeartbeatMs, HEARTBEAT_INTERVAL_MS)) {
      lastHeartbeatMs = millis();
      sendHeartbeat();
    }
    if (motorState != MOTOR_RUNNING && elapsed(lastAiMs, AI_INTERVAL_MS)) {
      lastAiMs = millis();
      fetchAi();
    }
    if (elapsed(lastCommandPollMs, COMMAND_POLL_MS)) {
      lastCommandPollMs = millis();
      pollCommand();
    }
  } else {
    // Keep sampling while offline so the queue can replay when Wi-Fi returns.
    if (elapsed(lastTelemetryMs, TELEMETRY_INTERVAL_MS)) {
      lastTelemetryMs = millis();
      postSample(currentSample());
    }
    if (elapsed(lastAiMs, AI_INTERVAL_MS)) {
      lastAiMs = millis();
      ai.fresh = false;
    }
  }

  if (elapsed(lastDecisionMs, DECISION_INTERVAL_MS)) {
    lastDecisionMs = millis();
    decisionEngine();
  }
}
