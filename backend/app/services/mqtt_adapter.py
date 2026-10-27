"""Optional MQTT bridge for real IoT devices.

Everything here degrades gracefully: when paho-mqtt, a broker or credentials are
missing the application keeps working in demo mode and simply reports
`mqtt_connected = false`. Commands are only published for real (non-simulated)
devices.
"""

from __future__ import annotations

import json
import logging
import threading
from typing import Callable

from ..config import get_settings

logger = logging.getLogger("soilingguard.mqtt")
settings = get_settings()

try:  # optional dependency
    import paho.mqtt.client as mqtt  # type: ignore

    PAHO_AVAILABLE = True
except Exception:  # pragma: no cover - paho not installed
    mqtt = None  # type: ignore
    PAHO_AVAILABLE = False


class MqttAdapter:
    def __init__(self) -> None:
        self._client = None
        self._connected = False
        self._lock = threading.Lock()

    @property
    def available(self) -> bool:
        return PAHO_AVAILABLE and bool(settings.mqtt_enabled) and bool(settings.mqtt_host)

    @property
    def connected(self) -> bool:
        return bool(self._connected)

    def start(self, on_message: Callable[[str, dict], None] | None = None) -> bool:
        if not self.available:
            if settings.mqtt_enabled and not PAHO_AVAILABLE:
                logger.warning("MQTT enabled but paho-mqtt is not installed.")
            return False
        with self._lock:
            if self._client is not None:
                return self._connected
            client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="soilingguard-api")
            if settings.mqtt_username:
                client.username_pw_set(settings.mqtt_username, settings.mqtt_password or None)

            def _on_connect(client, _userdata, _flags, reason_code, _properties=None):  # pragma: no cover
                self._connected = int(reason_code) == 0
                if self._connected:
                    client.subscribe(f"{settings.mqtt_topic_prefix}/+/telemetry")
                    logger.info("MQTT connected to %s", settings.mqtt_host)

            def _on_disconnect(client, _userdata, _flags, reason_code, _properties=None):  # pragma: no cover
                self._connected = False

            def _on_message(client, _userdata, msg):  # pragma: no cover - requires a broker
                if on_message is None:
                    return
                try:
                    payload = json.loads(msg.payload.decode("utf-8"))
                except (ValueError, UnicodeDecodeError):
                    return
                if isinstance(payload, dict):
                    on_message(msg.topic, payload)

            client.on_connect = _on_connect
            client.on_disconnect = _on_disconnect
            client.on_message = _on_message
            try:
                client.connect(settings.mqtt_host, settings.mqtt_port, keepalive=30)
                client.loop_start()
                self._client = client
                return True
            except Exception as exc:  # pragma: no cover
                logger.warning("MQTT connection failed: %s", exc)
                return False

    def stop(self) -> None:
        with self._lock:
            if self._client is not None:
                try:
                    self._client.loop_stop()
                    self._client.disconnect()
                except Exception:  # pragma: no cover
                    pass
                self._client = None
            self._connected = False

    def publish(self, topic: str, payload: dict) -> bool:
        """Publish a command. Returns False when no broker path exists."""
        if not self.connected or self._client is None:
            return False
        try:
            info = self._client.publish(topic, json.dumps(payload), qos=1)
            return info.rc == 0
        except Exception as exc:  # pragma: no cover
            logger.warning("MQTT publish failed: %s", exc)
            return False


mqtt_adapter = MqttAdapter()
