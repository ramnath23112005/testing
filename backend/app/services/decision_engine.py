"""Electrical + visual sensor-fusion decision engine.

Design principles (research requirements):

* A PV power decrease alone is NEVER attributed to dust. Cloud cover, shading,
  temperature, irradiance changes and electrical faults are explicitly considered.
* Environmental measurements are normalised when available; when they are
  missing the decision certainty is lowered and stated.
* Every decision returns transparent, evidence-backed explanation text and is
  persisted with its inputs.
* The policy mode (monitoring only / recommendation / manual / automatic)
  controls what the system is allowed to *do*, not what it is allowed to say.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import AiPrediction, CleaningDecision, CleaningJob, Device, TelemetryReading
from ..schemas import DecisionEvidence
from .settings_service import load_settings

ACTION_LABELS = {
    "no_action": "No action required",
    "cleaning_recommended": "Cleaning recommended",
    "cleaning_required": "Cleaning required",
    "cleaning_deferred": "Cleaning deferred",
    "insufficient_data": "Insufficient data",
    "possible_sensor_fault": "Possible sensor fault",
}


@dataclass
class DecisionResult:
    device_id: str
    action: str
    confidence: float
    explanation: str
    certainty: str
    inputs: dict = field(default_factory=dict)
    evidence: list[DecisionEvidence] = field(default_factory=list)
    generated_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    id: str = "pending"


def _age_s(ts: datetime | None, now: datetime) -> float | None:
    if ts is None:
        return None
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return (now - ts).total_seconds()


def latest_reading(db: Session, device_id: str) -> TelemetryReading | None:
    return db.execute(
        select(TelemetryReading)
        .where(TelemetryReading.device_id == device_id, TelemetryReading.quality != "missing")
        .order_by(TelemetryReading.ts.desc())
        .limit(1)
    ).scalar_one_or_none()


def latest_prediction(db: Session, device_id: str) -> AiPrediction | None:
    return db.execute(
        select(AiPrediction)
        .where(AiPrediction.device_id == device_id)
        .order_by(AiPrediction.created_at.desc())
        .limit(1)
    ).scalar_one_or_none()


def compute_reference_power(
    db: Session, device: Device, reading: TelemetryReading, cfg: dict
) -> tuple[float | None, str]:
    """Return (reference_w, method_note). Reference is irradiance-normalised when possible."""
    irr = reading.irradiance_wm2
    panel_temp = reading.panel_temp_c or 25.0
    rated = float(device.panel_rating_w)
    temp_factor = 1.0 - 0.004 * (panel_temp - 25.0)
    method = cfg["reference_power_method"]

    if method == "manual":
        manual = cfg.get("reference_power_w")
        if manual:
            if irr and irr > 20:
                return float(manual) * (irr / 1000.0) * temp_factor, "manual reference scaled by measured irradiance"
            return float(manual), "manual reference (not irradiance-scaled)"
        method = "fixed_rated"

    if method == "fixed_rated":
        if irr and irr > 20:
            return rated * (irr / 1000.0) * temp_factor, "rated power scaled by measured irradiance and panel temperature"
        return None, "fixed rated reference unavailable: no irradiance measurement"

    # rolling_peak: historical maximum at comparable irradiance
    if irr and irr > 50:
        low, high = irr * 0.85, irr * 1.15
        since = datetime.now(timezone.utc) - timedelta(days=7)
        rows = db.execute(
            select(TelemetryReading.power_w, TelemetryReading.irradiance_wm2)
            .where(
                TelemetryReading.device_id == device.id,
                TelemetryReading.ts >= since,
                TelemetryReading.power_w.is_not(None),
                TelemetryReading.irradiance_wm2.between(low, high),
            )
            .order_by(TelemetryReading.power_w.desc())
            .limit(500)
        ).all()
        if len(rows) >= 8:
            peak = float(max(r[0] for r in rows))
            return peak, f"rolling peak reference from {len(rows)} comparable readings (±15% irradiance, 7 days)"
        if device.panel_rating_w and irr:
            return (
                rated * (irr / 1000.0) * temp_factor,
                "rolling peak unavailable (insufficient comparable samples) - fell back to rated power",
            )
    return None, "rolling peak reference unavailable: no comparable irradiance samples"


def evaluate(db: Session, device_id: str, persist: bool = True) -> DecisionResult:
    cfg = load_settings(db)
    now = datetime.now(timezone.utc)
    device = db.get(Device, device_id)
    if device is None:
        return DecisionResult(
            device_id=device_id,
            action="insufficient_data",
            confidence=0.0,
            certainty="low",
            explanation="Device not found; no decision can be made.",
        )

    reading = latest_reading(db, device_id)
    prediction = latest_prediction(db, device_id)
    freshness = float(cfg["sensor_freshness_s"])

    inputs: dict = {
        "policy": cfg["policy"],
        "soiling_threshold_pct": cfg["soiling_threshold_pct"],
        "min_model_confidence": cfg["min_model_confidence"],
        "sensor_freshness_s": freshness,
        "device": device_id,
    }
    evidence: list[DecisionEvidence] = []

    # ------------------------- data quality gate ----------------------
    age = _age_s(reading.ts if reading else None, now)
    inputs["telemetry_age_s"] = round(age, 1) if age is not None else None
    if reading is None or age is None or age > freshness:
        inputs["telemetry_present"] = reading is not None
        return _finish(
            db,
            device_id,
            "insufficient_data",
            0.0,
            "low",
            (
                "No decision issued: telemetry is missing or older than the configured freshness limit "
                f"({freshness:.0f} s). Current age: {f'{age:.0f} s' if age is not None else 'unknown'}."
            ),
            inputs,
            [
                DecisionEvidence(label="Telemetry freshness", value=f"{age:.0f} s" if age is not None else "no data", impact="against_cleaning"),
                DecisionEvidence(label="Freshness limit", value=f"{freshness:.0f} s", impact="neutral"),
            ],
            persist,
        )

    if reading.quality == "stale":
        evidence.append(
            DecisionEvidence(label="Reading quality flag", value="stale (quality flag set by data pipeline)", impact="against_cleaning")
        )

    power = reading.power_w
    irr = reading.irradiance_wm2
    has_env = bool(device.has_irradiance_sensor) and irr is not None

    inputs.update(
        {
            "power_w": power,
            "voltage_v": reading.voltage_v,
            "current_a": reading.current_a,
            "irradiance_wm2": irr,
            "panel_temp_c": reading.panel_temp_c,
            "ambient_temp_c": reading.ambient_temp_c,
            "humidity_pct": reading.humidity_pct,
            "environmental_sensors": has_env,
        }
    )

    # ------------------------- irradiance gate ------------------------
    if power is None or (irr is not None and irr < 80):
        return _finish(
            db,
            device_id,
            "insufficient_data",
            0.2,
            "medium",
            (
                "No decision issued: irradiance is too low for a meaningful power comparison "
                f"(measured {irr if irr is not None else 'n/a'} W/m², minimum 80 W/m²). "
                "Power at night or under heavy cloud cannot indicate soiling."
            ),
            inputs,
            [
                DecisionEvidence(label="Irradiance", value=f"{irr if irr is not None else 'n/a'} W/m²", impact="against_cleaning"),
                DecisionEvidence(label="Minimum for evaluation", value="80 W/m²", impact="neutral"),
            ],
            persist,
        )

    # ------------------------- visual channel -------------------------
    pred_age = _age_s(prediction.created_at if prediction else None, now)
    inputs["prediction_age_s"] = round(pred_age, 1) if pred_age is not None else None
    inputs["predicted_class"] = prediction.predicted_class if prediction else None
    inputs["prediction_confidence"] = prediction.confidence if prediction else None
    inputs["prediction_source"] = prediction.source if prediction else None

    min_conf = float(cfg["min_model_confidence"])
    fresh_prediction = (
        prediction is not None and pred_age is not None and pred_age <= max(1800.0, freshness)
    )
    visual_support = bool(
        fresh_prediction
        and prediction is not None
        and prediction.predicted_class in {"heavily_dusty", "bird_dropping"}
        and prediction.confidence >= min_conf
    )
    visual_weak = bool(
        fresh_prediction
        and prediction is not None
        and prediction.predicted_class == "lightly_dusty"
        and prediction.confidence >= min_conf
    )

    if not fresh_prediction:
        evidence.append(
            DecisionEvidence(
                label="Visual classification",
                value="none recent enough" if prediction is not None else "no prediction available",
                impact="against_cleaning",
            )
        )
    else:
        evidence.append(
            DecisionEvidence(
                label=f"Visual: {prediction.predicted_class}",
                value=f"confidence {prediction.confidence:.0%} (min {min_conf:.0%})",
                impact="supports_cleaning" if (visual_support or visual_weak) else "against_cleaning",
            )
        )

    # ----------------------- electrical channel -----------------------
    ref_w, ref_note = compute_reference_power(db, device, reading, cfg)
    inputs["reference_w"] = round(ref_w, 1) if ref_w else None
    inputs["reference_method"] = ref_note
    evidence.append(
        DecisionEvidence(
            label="Reference power",
            value=f"{ref_w:.0f} W - {ref_note}" if ref_w else f"unavailable - {ref_note}",
            impact="neutral",
        )
    )

    loss: float | None = None
    if ref_w and ref_w > 0 and power is not None:
        loss = round((1.0 - power / ref_w) * 100.0, 2)
    inputs["normalized_power_loss_pct"] = loss
    threshold = float(cfg["soiling_threshold_pct"])
    max_loss = float(cfg["max_power_loss_pct"])

    if loss is None:
        evidence.append(
            DecisionEvidence(
                label="Normalised power loss",
                value="not computable (no reference or irradiance)",
                impact="against_cleaning",
            )
        )
    else:
        evidence.append(
            DecisionEvidence(
                label="Normalised power loss",
                value=f"{loss:.1f}% (threshold {threshold:.1f}%, fault cap {max_loss:.1f}%)",
                impact="supports_cleaning" if loss >= threshold else "against_cleaning",
            )
        )
        if loss < 0:
            evidence.append(
                DecisionEvidence(
                    label="Power above reference",
                    value="measurement exceeds reference; check reference method or soiling state",
                    impact="against_cleaning",
                )
            )

    # cooling/temperature effect on voltage
    if reading.panel_temp_c and reading.panel_temp_c > 45:
        evidence.append(
            DecisionEvidence(
                label="Panel temperature",
                value=f"{reading.panel_temp_c:.1f} °C - high temperature reduces output independently of soiling",
                impact="against_cleaning",
            )
        )

    elec_support = loss is not None and loss >= threshold
    elec_extreme = loss is not None and loss > max_loss

    # time since last cleaning
    last_clean = db.execute(
        select(CleaningJob.completed_at)
        .where(CleaningJob.device_id == device_id, CleaningJob.status == "completed")
        .order_by(CleaningJob.completed_at.desc())
        .limit(1)
    ).scalar_one_or_none()
    inputs["hours_since_cleaning"] = (
        round(_age_s(last_clean, now) / 3600.0, 1) if last_clean else None
    )

    certainty = _certainty(has_env, loss is not None, bool(reading.quality == "good"))

    # --------------------------- rule table ---------------------------
    action: str
    if elec_extreme and not (visual_support or visual_weak):
        action = "possible_sensor_fault"
        explanation = (
            f"Normalised power loss of {loss:.1f}% exceeds the configured fault cap of {max_loss:.1f}%, "
            "but the visual classifier does not confirm soiling "
            f"(prediction: {prediction.predicted_class if prediction else 'none'}). "
            "A loss of this magnitude is more consistent with a string/connection fault, heavy shading, "
            "soiling beyond the model's training distribution, or a bad reference. "
            "Cleaning is not authorised from this evidence alone - inspect the array and capture a new image."
        )
    elif visual_support and elec_support:
        action = "cleaning_required"
        explanation = (
            f"Cleaning required: the image classifier detected "
            f"{prediction.predicted_class.replace('_', ' ')} with {prediction.confidence:.0%} confidence "
            f"and the normalised power-loss estimate of {loss:.1f}% exceeds the configured threshold of "
            f"{threshold:.1f}% ({ref_note})."
        )
        if not has_env:
            explanation += (
                " Environmental sensors are unavailable, so the electrical corroboration is not fully normalised "
                "and decision certainty is reduced."
            )
    elif visual_support and not elec_support:
        action = "cleaning_recommended"
        if loss is None:
            explanation = (
                f"Cleaning recommended on visual evidence only ({prediction.predicted_class.replace('_', ' ')} "
                f"at {prediction.confidence:.0%} confidence). Normalised power loss could not be computed "
                "because the required environmental/reference measurements are unavailable, so the electrical "
                "channel neither supports nor contradicts the classification."
            )
        else:
            explanation = (
                f"Cleaning recommended because the image classifier detected "
                f"{prediction.predicted_class.replace('_', ' ')} at {prediction.confidence:.0%} confidence, "
                f"while the normalised power loss of {loss:.1f}% remains below the {threshold:.1f}% threshold. "
                "Localized contamination can be visible before it measurably reduces output."
            )
        certainty = "low" if not has_env else certainty
    elif visual_weak and elec_support:
        action = "cleaning_recommended"
        explanation = (
            f"Cleaning recommended: the classifier reports light soiling ({prediction.confidence:.0%} confidence) "
            f"and the normalised power loss of {loss:.1f}% reaches the configured {threshold:.1f}% threshold. "
            "Evidence is consistent but not conclusive; a second image is advised after cleaning."
        )
    elif elec_support and not (visual_support or visual_weak):
        action = "cleaning_deferred"
        explanation = (
            f"Cleaning deferred: normalised power loss of {loss:.1f}% reaches the {threshold:.1f}% threshold, "
            f"but the visual classification does not support soiling"
            + (
                f" ({prediction.predicted_class.replace('_', ' ')} at {prediction.confidence:.0%} confidence). "
                if prediction is not None
                else " (no recent prediction). "
            )
            + "Power loss alone can be caused by cloud cover, shading, temperature, soiling of the opposite "
            "string or an electrical fault. Capture a new image before authorising cleaning."
        )
    elif visual_weak and not elec_support:
        action = "no_action"
        explanation = (
            f"No action: light soiling detected ({prediction.confidence:.0%} confidence) but normalised power "
            f"loss ({loss if loss is not None else 'n/a'}%) stays below the {threshold:.1f}% threshold. "
            "Continue monitoring; the next scheduled inspection will re-evaluate."
        )
    else:
        action = "no_action"
        explanation = (
            "No action: the panel appears "
            f"{prediction.predicted_class if prediction else 'unchanged (no recent classification)'} "
            f"and normalised power loss ({loss if loss is not None else 'n/a'}%) is below the "
            f"{threshold:.1f}% threshold."
        )

    # ----------------------- cooldown / interval ----------------------
    cooldown = float(cfg["cleaning_cooldown_s"])
    if action in {"cleaning_recommended", "cleaning_required"} and last_clean is not None:
        since = _age_s(last_clean, now) or 0
        if since < cooldown:
            remaining = cooldown - since
            inputs["cooldown_remaining_s"] = round(remaining, 1)
            action = "cleaning_deferred"
            explanation += (
                f" Cleaning deferred: the configured cooldown of {cooldown / 60:.0f} minutes has not elapsed "
                f"({remaining / 60:.1f} minutes remaining)."
            )

    if action in {"cleaning_recommended", "cleaning_required"}:
        policy = cfg["policy"]
        if policy == "monitoring_only":
            explanation += " Policy is 'Monitoring only' - the recommendation is recorded but no cleaning will be started."
        elif policy == "recommendation_only":
            explanation += " Policy is 'Recommendation only' - operator approval is required before any cycle starts."
        elif policy == "manual_approval":
            explanation += " Policy is 'Manual approval required' - an operator must confirm the cycle."

    confidence = _action_confidence(action, visual_support, visual_weak, elec_support, certainty)
    return _finish(db, device_id, action, confidence, certainty, explanation, inputs, evidence, persist)


def _certainty(has_env: bool, loss_available: bool, good_quality: bool) -> str:
    if has_env and loss_available and good_quality:
        return "high"
    if loss_available or has_env:
        return "medium"
    return "low"


def _action_confidence(action: str, visual: bool, weak: bool, elec: bool, certainty: str) -> float:
    if action in {"insufficient_data", "possible_sensor_fault"}:
        return 0.55 if elec or visual else 0.4
    if action == "no_action":
        return 0.7 if not (visual or elec) else 0.6
    base = 0.5
    if visual:
        base += 0.2
    if elec:
        base += 0.2
    if weak:
        base -= 0.1
    if certainty == "high":
        base += 0.1
    elif certainty == "low":
        base -= 0.1
    return round(max(0.1, min(0.97, base)), 2)


def _finish(
    db: Session,
    device_id: str,
    action: str,
    confidence: float,
    certainty: str,
    explanation: str,
    inputs: dict,
    evidence: list[DecisionEvidence],
    persist: bool,
) -> DecisionResult:
    result = DecisionResult(
        device_id=device_id,
        action=action,
        confidence=confidence,
        explanation=explanation,
        certainty=certainty,
        inputs=inputs,
        evidence=evidence,
    )
    if persist:
        row = CleaningDecision(
            device_id=device_id,
            action=action,
            confidence=confidence,
            explanation=explanation,
            policy=str(inputs.get("policy", "monitoring_only")),
            certainty=certainty,
            inputs_json=json.dumps(inputs, default=str),
            evidence_json=json.dumps([e.model_dump() for e in evidence], default=str),
            source="measured" if inputs.get("telemetry_present") is not False else "simulated",
            ts=result.generated_at,
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        result.id = row.id
    return result


def to_outcome(result: DecisionResult) -> dict:
    return {
        "id": result.id,
        "device_id": result.device_id,
        "action": result.action,
        "action_label": ACTION_LABELS[result.action],
        "confidence": result.confidence,
        "explanation": result.explanation,
        "generated_at": result.generated_at,
        "policy": str(result.inputs.get("policy", "monitoring_only")),
        "certainty": result.certainty,
        "inputs": result.inputs,
        "evidence": [e.model_dump() for e in result.evidence],
        "source": "simulated" if result.inputs.get("irradiance_wm2") is None else "measured",
    }


def row_out(row: CleaningDecision) -> dict:
    """Serialise a persisted decision to the API Decision shape."""
    try:
        inputs = json.loads(row.inputs_json or "{}")
    except json.JSONDecodeError:
        inputs = {}
    try:
        evidence = json.loads(row.evidence_json or "[]")
    except json.JSONDecodeError:
        evidence = []
    return {
        "id": row.id,
        "device_id": row.device_id,
        "action": row.action,
        "action_label": ACTION_LABELS.get(row.action, row.action),
        "confidence": row.confidence,
        "explanation": row.explanation,
        "generated_at": row.ts,
        "policy": row.policy,
        "certainty": row.certainty,
        "inputs": inputs,
        "evidence": evidence,
        "source": row.source,
    }
