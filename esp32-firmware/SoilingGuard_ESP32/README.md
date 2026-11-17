# SoilingGuard ESP32 firmware

Arduino IDE sketch for the hardware tier of SoilingGuard. The board measures a
solar panel (INA219 + LDR + DS18B20), uploads **measured** values to the
SoilingGuard backend, reads the latest visual AI classification, executes
cleaning cycles authorised from the dashboard, and can ask the backend for a
cleaning cycle itself when its onboard decision engine is convinced the panel is
dirty. Every cycle is verified with a before/after power comparison.

```
ESP32 ──HTTP──> FastAPI backend ──> SQLite/Postgres ──> React dashboard
  │                  ▲
  │  /api/ai/latest   │  laptop CNN posts /api/ai/ingest
  └───────────────────┘
```

The firmware is a **prototype**, not a certified safety device. It drives a real
motor. Read [Safety](#safety) before powering the motor driver.

---

## 1. Bill of materials

| Part | Notes |
|---|---|
| ESP32 DevKit V1 (ESP32-WROOM-32) | 30-pin board used for the pin map below |
| INA219 breakout | I²C, 32 V / 2 A calibration |
| LDR (GL5528 or similar) + 10 kΩ resistor | relative light level only |
| DS18B20 waterproof probe + 4.7 kΩ resistor | bonded to the panel back sheet |
| L298N or TB6612FNG motor driver | 5–12 V motor supply |
| DC gear motor / linear actuator | moves the cleaning brush |
| Separate 12 V supply for the motor | **never** power the motor from the ESP32 |
| Physical emergency-stop switch | in series with the motor supply |
| 100 µF electrolytic + 100 nF ceramic | across the motor supply, near the driver |

## 2. Wiring

### ESP32 pin map (as compiled in the sketch)

| Signal | ESP32 pin | Notes |
|---|---|---|
| INA219 SDA | GPIO 21 | 3.3 V logic |
| INA219 SCL | GPIO 22 | 3.3 V logic |
| LDR divider output | GPIO 34 | input-only, ADC1 → safe with Wi-Fi on |
| DS18B20 data | GPIO 4 | 4.7 kΩ pull-up to 3V3 |
| Motor driver IN1 | GPIO 26 | direction |
| Motor driver IN2 | GPIO 27 | direction |
| Motor driver ENA | GPIO 25 | PWM, 20 kHz, 8-bit |
| Status LED | GPIO 2 | onboard LED, strapping pin (kept LOW at boot) |

### Power

```
12 V PSU ──(+)── physical E-STOP ── L298N +12V
          └(–)──────────────────── L298N GND ── ESP32 GND   (common ground!)
ESP32 5V/VIN ── L298N 5V (only if the driver jumper is fitted and the PSU can
                         supply the ESP32; otherwise power the ESP32 over USB)
```

* Common ground between the ESP32, the INA219 and the motor supply is mandatory.
* Add the 100 µF + 100 nF capacitors across the motor supply at the driver.
* If the board resets when the motor starts, the supply is sagging: use a bigger
  PSU or a separate 5 V regulator for the ESP32.

### INA219 placement (read this)

The INA219 measures the **panel side** of the system:

```
panel (+) ── INA219 VIN+ ──[shunt]── INA219 VIN– ── charge controller / load
panel (–) ──────────────────────────────────────── common ground
```

* Voltage is panel voltage, current is panel current, power is their product.
* The sketch uses the 32 V / 2 A calibration (`INA219_MAX_AMPS = 2.0`). Readings
  above ~2.1 A are **discarded**, not clamped, so a 100 W/12 V panel (≈8 A)
  needs a different shunt/calibration or a Hall sensor. Keep this tree honest:
  an out-of-range reading is reported as unavailable.
* Do not put the INA219 on the battery/load side and call it panel power.

### LDR divider

```
3V3 ── LDR ──┬── 10 kΩ ── GND
             └── GPIO 34
```

Either orientation works, because calibration values are measured, not assumed.
If the LDR is wired the other way round the sketch reads 0 % (safe: no cleaning),
and you fix it by swapping `LDR_ADC_DARK` / `LDR_ADC_BRIGHT`.

### DS18B20

```
3V3 ── 4.7 kΩ ── GPIO 4 (DQ)
GPIO 4 ── DS18B20 DQ
GND ───── DS18B20 GND
3V3 ───── DS18B20 VDD
```

The probe is read as panel temperature (back-sheet proxy). The backend stores it
in `ambient_temp_c`, which is the closest field the schema has.

## 3. Arduino IDE setup

1. **Boards Manager** → install *esp32 by Espressif Systems* (core 2.x or 3.x;
   the LEDC calls are version-guarded).
2. **Board:** `ESP32 Dev Module`. Leave flash size/speed at defaults, 115200 baud.
3. **Library Manager**, install:
   * Adafruit INA219 ≥ 1.2.3 (also pulls *Adafruit BusIO*)
   * OneWire ≥ 2.3.8
   * DallasTemperature ≥ 3.9.1
   * **ArduinoJson 7.x** — v6 will not compile (the sketch uses `JsonDocument`)
4. Open `SoilingGuard_ESP32.ino`, edit the configuration block, upload.

Keep the sketch folder name equal to the `.ino` name.

## 4. Configuration

All user settings are at the top of the sketch:

| Constant | Default | Meaning |
|---|---|---|
| `WIFI_SSID` / `WIFI_PASSWORD` | placeholders | 2.4 GHz network only |
| `API_BASE` | `http://192.168.1.50:8000` | backend root, no trailing `/` |
| `DEVICE_ID` | `PV-ESP32-01` | must match the seeded hardware device |
| `DEVICE_API_KEY` | `soilingguard-esp32-key` | must equal backend `IOT_DEVICE_KEY` |
| `PANEL_RATED_W` | `100` | nameplate power used for the baseline |
| `LDR_ADC_DARK` / `LDR_ADC_BRIGHT` | `200` / `3400` | **calibrate per installation** |
| `DEFAULT_SPEED_PCT` | `60` | motor duty for local cycles |
| `MAX_CLEAN_SECONDS` | `120` | hard cap, also caps server commands |
| `SETTLE_SECONDS` | `10` | wait after the motor stops before verifying |
| `MIN_CLEAN_INTERVAL_S` | `600` | cooldown between cycles / self-requests |
| `MIN_CLEAN_LIGHT_PCT` | `30` | below this the camera image is unreliable |
| `MAX_CLEAN_TEMP_C` | `60` | do not run the mechanism on a hot panel |
| `SOILING_TRIGGER_PCT` | `15` | measured loss needed before an auto cycle |
| `DRY_RUN` | `false` | `true` = complete logic with motor pins LOW |
| `ALLOW_DEMO_AI` | `false` | `true` = accept demo/labelled AI results |

`http://` is used by default for the LAN. `https://` works too (e.g. the Render
URL) via `WiFiClientSecure`; see [TLS](#tls).

## 5. Pairing with the backend

The backend seeds the hardware device and the test account automatically:

```ini
# backend/.env
IOT_DEVICE_KEY=soilingguard-esp32-key
IOT_DEFAULT_DEVICE_ID=PV-ESP32-01
SEED_TEST_USERNAME=Test
SEED_TEST_PASSWORD=Test
```

1. Start the backend (`uvicorn app.main:app ...`) and sign in to the dashboard as
   `Test` / `Test` (admin role).
2. The device `PV-ESP32-01` ("Solar Array B (ESP32 hardware)") exists, offline,
   `simulated = false`. It turns **online** on the first telemetry/heartbeat.
3. Select it in the dashboard. Telemetry appears under Live Monitoring with
   source `measured`; the irradiance tile is replaced by **Light level (%)**
   because an LDR is not an irradiance sensor.
4. To allow cleaning, an admin must change the policy (default is
   `monitoring_only`): Settings → policy `manual_approval` (dashboard and AUTO
   cycles both allowed after confirmation) or `automatic`.

The firmware refuses to invent data: a missing sensor simply omits the field.

## 6. First power-up

1. Open Serial Monitor at **115200**.
2. Expect the banner, sensor detection lines, Wi-Fi connection with an IP, then
   the command help. `STATUS` shows `ina219/ldr/ds18b20` health.
3. Run `CAL` at night/covered and at noon in direct sun; put those raw ADC values
   into `LDR_ADC_DARK` / `LDR_ADC_BRIGHT` and re-upload. Verify `READ` matches a
   multimeter/ammeter within a few percent.
4. Confirm the dashboard shows the device online and receives a sample every
   15 s (`/api/telemetry` every 15 s, heartbeat every 30 s).
5. Push a real classification from the laptop CNN (see `/api/ai/ingest` below),
   then press **Start cleaning** in the dashboard. The firmware receives START on
   its next 5 s poll, runs the cycle, waits `SETTLE_SECONDS`, measures again and
   posts the result.

## 7. API contract (firmware ↔ backend)

All requests carry `X-Device-Key: <IOT_DEVICE_KEY>`.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/telemetry` | measured values (15 s) |
| POST | `/api/device/status` | heartbeat + sensor health (30 s) |
| GET | `/api/ai/latest?device_id=…` | newest visual classification (60 s) |
| POST | `/api/cleaning/auto-request` | onboard decision requests a cycle |
| GET | `/api/cleaning/command?device_id=…` | START / STOP / NONE (5 s, idle only) |
| POST | `/api/cleaning/result` | cycle outcome + before/after power |

Telemetry body (fields are omitted when the sensor is unavailable):

```json
{
  "device_id": "PV-ESP32-01",
  "timestamp": 1763456789,
  "voltage": 12.4,
  "current": 0.85,
  "power": 10.54,
  "light_level": 82.0,
  "temperature": 32.5,
  "motor_status": "stopped",
  "wifi_status": "connected",
  "wifi_rssi": -58,
  "firmware_version": "1.0.0",
  "quality": "good"
}
```

Result body:

```json
{
  "job_id": "…",
  "device_id": "PV-ESP32-01",
  "status": "completed",
  "duration_s": 45,
  "power_before": 10.42,
  "power_after": 12.31,
  "outcome": "cleaning_successful",
  "note": "light 82%->83%, temp 32.4->33.1C"
}
```

Outcomes: `cleaning_successful` (≥ +5 %), `no_significant_change` (±5 %),
`degraded` (≤ −2 %), `verification_unavailable` (light/temp not comparable),
`stop_requested`, `estop`, `serial_stop`.

Push a laptop CNN result so the ESP32 and dashboard share it:

```bash
curl -X POST "$API/api/ai/ingest" \
  -H "X-Device-Key: soilingguard-esp32-key" \
  -H "Content-Type: application/json" \
  -d '{"device_id":"PV-ESP32-01","predicted_class":"heavy_dust",
       "confidence":0.94,
       "probabilities":{"clean":0.02,"light_dust":0.02,"heavy_dust":0.94,"bird_dropping":0.02},
       "recommendation":"CLEAN_RECOMMENDED","model_name":"solar-cnn","model_version":"1.0.0"}'
```

Aliases `light_dust` / `heavy_dust` are accepted; the backend stores
`lightly_dusty` / `heavily_dusty` and returns both spellings.

## 8. Onboard decision engine

Runs every 30 s while idle. It never starts the motor directly from an AI
prediction: it either follows a dashboard START or asks `/api/cleaning/auto-request`,
which re-checks policy, interlocks and cooldown server-side.

| Case | Situation | Action |
|---|---|---|
| 1 | light < `NIGHT_LIGHT_PCT` | no action (image useless at night) |
| 2 | E-STOP latched | no action until `RESET` |
| 3 | no fresh AI (< 5 min) or demo result and `ALLOW_DEMO_AI=false` | recommend manual inspection, no automatic action |
| 4 | AI says `clean` | no action; warn if measured loss > 30 % (baseline/wiring suspect) |
| 5 | AI says `lightly_dusty` | monitor only |
| 6 | `heavily_dusty` (conf ≥ 0.75) or `bird_dropping` (conf ≥ 0.85) | request a cycle if light ≥ 30 %, temp ≤ 60 °C, electrical sensor healthy, loss ≥ 15 %, AUTO on, cooldown expired; otherwise explain why not |
| 7 | cycle ran less than `MIN_CLEAN_INTERVAL_S` ago | cooling down, print last verification |

`AUTO ON` is local and persists in NVS. With `AUTO OFF` the board only prints
recommendations and still executes dashboard commands. Bird droppings may need
manual removal even after a successful cycle - the log says so.

## 9. Safety

* Motor outputs are LOW from `setup()` until a cycle starts. No motion at boot.
* `MAX_CLEAN_SECONDS` caps any command, including an absurd server value.
* E-STOP is latched in NVS, cuts the PWM immediately, reports the interrupted
  cycle as `stopped`, and survives reboots until `RESET`.
* STOP from the dashboard is honoured on the next 5 s poll (the dashboard also
  sets a `STOP_REQUESTED` marker server-side). HTTP calls block the loop for up
  to 4 s, so worst-case stop latency is roughly poll interval + timeout (~9 s).
  Keep the physical E-STOP for anything that must stop immediately.
* `DRY_RUN = true` exercises the whole state machine without energising the motor.
* There are **no limit switches** in this design: the cycle duration is the only
  travel control. Fit mechanical stops, a slipping clutch or limit switches
  before unattended operation.
* Provide a hardware E-STOP in series with the motor supply. The firmware E-STOP
  assumes the ESP32 is alive.
* One cycle at a time; command polling is suspended while the motor is busy.
* Mechanical parts, water and mains voltage are outside this sketch's control.

## 10. Tests (bring-up checklist)

| # | Test | Expected |
|---|---|---|
| 1 | Compile + upload | no errors, banner appears at 115200 |
| 2 | Boot with motor connected | no movement, status LED heartbeat |
| 3 | `STATUS` | sensors `ok`, `estop=clear`, `auto=off` |
| 4 | Wi-Fi loss (router off/on) | reconnect ≤ 15 s, no reboot, telemetry resumes |
| 5 | Dashboard | device `PV-ESP32-01` online, source `measured`, light tile present |
| 6 | `CAL` + `READ` | LDR calibration sane, INA219 agrees with a multimeter |
| 7 | Unplug DS18B20 | temp reported unavailable, `quality=missing`, no crash |
| 8 | AI ingest curl | `/api/ai/latest` returns class, aliases and demo flag |
| 9 | Dashboard START | 5 s poll → motor runs → result with improvement |
| 10 | Dashboard STOP mid-cycle | motor stops, job status `stopped` |
| 11 | `ESTOP` then power-cycle | latch survives, `RESET` clears it |
| 12 | AUTO ON with a real `heavy_dust` prediction | device requests a cycle; refusal reason visible when policy is `monitoring_only` |
| 13 | Wi-Fi down during telemetry | samples buffered (≤ 12), flushed after reconnect |
| 14 | Evening/low light | no auto cycle (case 1), dashboard still updates |

## 11. Troubleshooting

| Symptom | Likely cause |
|---|---|
| `[ina219] NOT FOUND` | SDA/SCL swapped, no pull-ups, 5 V logic module, missing ground |
| Current always 0 | shunt not in series, load below 10 mA, calibration mismatch |
| Voltage ≈ 0 at noon | panel disconnected, shunt open, INA219 on the wrong side |
| Light always 0 % | divider orientation, `LDR_ADC_*` not calibrated, GPIO34 not connected |
| `temp=n/a` | DS18B20 missing 4.7 kΩ pull-up or `getDeviceCount()==0` |
| Board resets when the motor starts | supply sag / no capacitors / shared 5 V rail |
| Motor spins the wrong way | swap IN1/IN2 (or motor leads) |
| HTTP 401 | `DEVICE_API_KEY` ≠ backend `IOT_DEVICE_KEY` |
| HTTP 404 on `/api/cleaning/result` | no matching job (local START without a dashboard job) |
| HTTPS fails | board clock not synced yet (NTP), or captive portal; retry after Wi-Fi is up |
| Duplicate samples | two boards with the same `DEVICE_ID` |
| Clean result but no visible improvement | brush not touching, panel already clean, light/temp changed |

## 12. Limitations

* The LDR gives a **relative** light index, not W/m². `expectedW` and `lossPct`
  are approximations for gating only; the dashboard shows light as %.
* The INA219 is calibrated for 2 A. A 100 W/12 V panel at full sun exceeds it;
  treat electrical readings as valid only for currents within range.
* No humidity/rain sensor is wired. Rain detection is not implemented.
* Panel temperature is a back-sheet probe, stored in `ambient_temp_c`.
* Single-actuator design, no position feedback, no limit switches, no OTA update,
  no MQTT (the REST bridge is the only transport).
* `WiFiClientSecure::setInsecure()` disables certificate validation. For
  production, load the backend CA and use `setCACert()`.

### TLS

Set `API_BASE` to the `https://` URL and flash. The board needs a synced clock
(NTP is configured after Wi-Fi connects) - if the first HTTPS call fails right
after boot, the next attempt 5–60 s later succeeds. Certificate pinning is a
one-line change (`tlsClient.setCACert(ROOT_CA)`), see the [ESP32 docs](https://docs.espressif.com/projects/arduino-esp32/en/latest/api/wifi.html).

## 13. Serial commands

`HELP`, `STATUS`, `READ`, `CAL`, `START [s] [pct]`, `STOP`, `ESTOP`, `RESET`,
`AUTO ON|OFF`, `SPEED <10-100>`, `QUEUE`.

`START` without a dashboard job runs a **local** cycle for bench testing; its
result is logged on the serial console only (the backend needs a job to attach
it to).
