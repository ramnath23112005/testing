"""Analytics aggregation: detections, cleaning outcomes, energy and model metrics.

All derived numbers are computed from persisted rows only. Where a value cannot
be established (e.g. model accuracy without independently verified labels) the
payload reports `available = false` with a reason instead of inventing a number.
"""

from __future__ import annotations

import json
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import (
    AiPrediction,
    CleaningDecision,
    CleaningJob,
    GroundTruthLabel,
    TelemetryReading,
)
from .settings_service import load_settings

SUCCESS_CRITERION = "completed cycles whose normalised (or raw, when no irradiance sensor) post-clean power exceeded the pre-clean window"


def _aware(dt: datetime | None) -> datetime:
    if dt is None:
        return datetime.now(timezone.utc)
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _parse(value: str | None, default: datetime) -> datetime:
    if not value:
        return default
    try:
        return _aware(datetime.fromisoformat(value.replace("Z", "+00:00")))
    except ValueError:
        return default


def _bucket(conf: float) -> str:
    lo = min(9, int(conf * 10))
    return f"{lo / 10:.1f}-{(lo + 1) / 10:.1f}"


def _macro_scores(pairs: list[tuple[str, str]], classes: list[str]) -> dict:
    """Macro precision / recall / F1 over the given (truth, predicted) pairs."""
    precisions, recalls, f1s = [], [], []
    for cls in classes:
        tp = sum(1 for t, p in pairs if t == cls and p == cls)
        fp = sum(1 for t, p in pairs if t != cls and p == cls)
        fn = sum(1 for t, p in pairs if t == cls and p != cls)
        prec = tp / (tp + fp) if (tp + fp) else 0.0
        rec = tp / (tp + fn) if (tp + fn) else 0.0
        f1 = (2 * prec * rec / (prec + rec)) if (prec + rec) else 0.0
        precisions.append(prec)
        recalls.append(rec)
        f1s.append(f1)
    n = max(1, len(classes))
    accuracy = sum(1 for t, p in pairs if t == p) / len(pairs) if pairs else None
    return {
        "accuracy": round(accuracy, 4) if accuracy is not None else None,
        "precision": round(sum(precisions) / n, 4),
        "recall": round(sum(recalls) / n, 4),
        "f1": round(sum(f1s) / n, 4),
        "support": len(pairs),
    }


def build_summary(
    db: Session,
    start: datetime,
    end: datetime,
    device_id: str | None = None,
) -> dict:
    cfg = load_settings(db)
    demo_mode = bool(cfg.get("demo_mode", True))

    # ---------------------------- predictions -------------------------
    preds = db.execute(
        select(AiPrediction)
        .where(AiPrediction.created_at >= start, AiPrediction.created_at <= end)
        .order_by(AiPrediction.created_at.asc())
    ).scalars().all()

    classification_counts: dict[str, int] = defaultdict(int)
    by_day: dict[str, list[float]] = defaultdict(list)
    hist: dict[str, int] = defaultdict(int)
    for p in preds:
        classification_counts[p.predicted_class] += 1
        day = _aware(p.created_at).astimezone().date().isoformat()
        by_day[day].append(p.confidence)
        hist[_bucket(p.confidence)] += 1

    detections_over_time = [
        {"date": day, "count": len(vals), "avg_confidence": round(sum(vals) / len(vals), 3)}
        for day, vals in sorted(by_day.items())
    ]
    confidence_histogram = [
        {"bucket": f"{i / 10:.1f}-{(i + 1) / 10:.1f}", "count": hist.get(f"{i / 10:.1f}-{(i + 1) / 10:.1f}", 0)}
        for i in range(10)
    ]

    # ---------------------------- decisions ---------------------------
    decisions = db.execute(
        select(CleaningDecision).where(CleaningDecision.ts >= start, CleaningDecision.ts <= end)
    ).scalars().all()
    cleaning_recommendations = sum(
        1 for d in decisions if d.action in {"cleaning_recommended", "cleaning_required"}
    )

    # ---------------------------- cleaning ----------------------------
    job_q = select(CleaningJob).where(CleaningJob.requested_at >= start, CleaningJob.requested_at <= end)
    if device_id:
        job_q = job_q.where(CleaningJob.device_id == device_id)
    jobs = db.execute(job_q.order_by(CleaningJob.requested_at.asc())).scalars().all()

    completed = [j for j in jobs if j.status == "completed"]
    failed = [j for j in jobs if j.status in {"failed", "aborted"}]
    stopped = [j for j in jobs if j.status == "stopped"]
    durations = [j.duration_s for j in completed if j.duration_s is not None]

    repeated_24h = 0
    for i, job in enumerate(completed):
        for prev in completed[:i]:
            gap = abs((_aware(job.requested_at) - _aware(prev.requested_at)).total_seconds())
            if gap <= 86_400:
                repeated_24h += 1
                break

    judged = [j for j in completed if j.delta_pct is not None]
    successes = [j for j in judged if j.delta_pct > 0]
    success_rate = round(len(successes) / len(judged) * 100.0, 1) if judged else None

    power_before_after = [
        {
            "id": j.id[:12],
            "when": (_aware(j.completed_at) or _aware(j.requested_at)).isoformat(),
            "before_w": round(j.power_before_w, 1),
            "after_w": round(j.power_after_w, 1),
            "delta_pct": round(j.delta_pct, 2),
        }
        for j in judged
    ]

    normalised_all = all("normalised" in (j.measurement_note or "").lower() for j in judged) if judged else False
    avg_delta = round(sum(j.delta_pct for j in judged) / len(judged), 2) if judged else None
    recovered_wh = None
    if judged:
        recovered_wh = round(
            sum(
                (j.power_before_w or 0) * (j.delta_pct / 100.0) * ((j.duration_s or 0) / 3600.0)
                for j in judged
            ),
            2,
        )

    power_recovery = {
        "measured": bool(normalised_all and judged),
        "note": (
            "all contributing windows were irradiance-normalised before comparison"
            if normalised_all and judged
            else "raw power windows without irradiance normalisation (cloud, temperature and time-of-day effects are not removed)"
            if judged
            else "no completed cycle with comparable before/after windows in this range"
        ),
        "avg_delta_pct": avg_delta,
        "estimated_recovered_wh": recovered_wh,
        "cleaning_energy_wh": round(sum(j.energy_wh or 0 for j in jobs), 2),
    }

    cleaning_stats = {
        "cycles": len(completed),
        "failed": len(failed),
        "avg_duration_s": round(sum(durations) / len(durations), 1) if durations else 0.0,
        "water_l": round(sum(j.water_liters or 0 for j in jobs), 2),
        "energy_wh": round(sum(j.energy_wh or 0 for j in jobs), 2),
        "aborted": len(stopped),
        "repeated_24h": repeated_24h,
        "success_rate_pct": success_rate,
        "success_criterion": SUCCESS_CRITERION,
    }

    # ----------------------------- energy -----------------------------
    tq = select(TelemetryReading.ts, TelemetryReading.power_w, TelemetryReading.irradiance_wm2).where(
        TelemetryReading.ts >= start, TelemetryReading.ts <= end, TelemetryReading.power_w.is_not(None)
    )
    if device_id:
        tq = tq.where(TelemetryReading.device_id == device_id)
    trows = db.execute(tq.order_by(TelemetryReading.ts.asc())).all()

    daily: dict[str, float] = defaultdict(float)
    hourly: dict[str, list[float]] = defaultdict(lambda: [0.0, 0.0, 0.0])
    for ts, power, _irr in trows:
        local = _aware(ts).astimezone()
        daily[local.date().isoformat()] += (power or 0) / 60.0  # 1-minute sampling → Wh per tick
        bucket = local.replace(minute=0, second=0, microsecond=0)
        entry = hourly[bucket.isoformat()]
        entry[0] += power or 0.0
        entry[1] += 1.0
        entry[2] += _irr if _irr else 0.0
    energy_series = [{"date": d, "wh": round(v, 1)} for d, v in sorted(daily.items())]

    # performance vs reference (rated power scaled by measured irradiance)
    rated = None
    if device_id:
        from ..models import Device

        dev = db.get(Device, device_id)
        rated = float(dev.panel_rating_w) if dev else None
    perf_series = []
    if rated:
        for bucket_iso, (p_sum, n, i_sum) in sorted(hourly.items()):
            if n <= 0:
                continue
            avg_power = p_sum / n
            avg_irr = i_sum / n
            if avg_irr < 80:
                continue  # low irradiance hours are not comparable
            reference = rated * (avg_irr / 1000.0)
            if reference <= 0:
                continue
            perf_series.append(
                {
                    "ts": bucket_iso,
                    "actual_w": round(avg_power, 1),
                    "reference_w": round(reference, 1),
                    "ratio": round(avg_power / reference, 3),
                }
            )
    perf_series = perf_series[-400:]

    # -------------------------- model metrics -------------------------
    label_rows = db.execute(
        select(GroundTruthLabel.label, AiPrediction.predicted_class)
        .join(AiPrediction, AiPrediction.image_id == GroundTruthLabel.image_id)
        .where(AiPrediction.created_at >= start, AiPrediction.created_at <= end)
    ).all()
    if label_rows:
        model_metrics = {
            "available": True,
            "note": (
                f"Computed against {len(label_rows)} independently verified label(s) in this range. "
                + ("Labels originate from demo-generated imagery." if demo_mode else "")
            ),
            **_macro_scores([(r[0], r[1]) for r in label_rows], ["clean", "lightly_dusty", "heavily_dusty", "bird_dropping"]),
        }
    else:
        model_metrics = {
            "available": False,
            "note": "No independently verified ground-truth labels exist for this range, so accuracy/precision/recall/F1 cannot be reported. Label images on the Detection page to enable evaluation.",
            "accuracy": None,
            "precision": None,
            "recall": None,
            "f1": None,
            "support": 0,
        }

    source = "simulated" if demo_mode else "measured"
    return {
        "source": source,
        "simulated": demo_mode,
        "classification_counts": dict(classification_counts),
        "detections_over_time": detections_over_time,
        "confidence_histogram": confidence_histogram,
        "cleaning_recommendations": cleaning_recommendations,
        "confirmed_cleaning_events": len(completed),
        "power_before_after": power_before_after,
        "energy_series": energy_series,
        "perf_series": perf_series,
        "cleaning_stats": cleaning_stats,
        "model_metrics": model_metrics,
        "power_recovery": power_recovery,
    }


def events_csv(db: Session, start: datetime | None, end: datetime | None, search: str | None, event_type: str | None) -> str:
    import csv
    import io

    from ..models import SystemEvent
    from .events import EVENT_LABELS

    q = select(SystemEvent)
    if start:
        q = q.where(SystemEvent.ts >= start)
    if end:
        q = q.where(SystemEvent.ts <= end)
    if event_type:
        q = q.where(SystemEvent.event_type == event_type)
    if search:
        q = q.where(SystemEvent.description.ilike(f"%{search}%"))
    rows = db.execute(q.order_by(SystemEvent.ts.desc()).limit(50_000)).scalars().all()

    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["timestamp", "event_type", "event_label", "device_id", "status", "actor", "description"])
    for r in rows:
        w.writerow([
            _aware(r.ts).isoformat(),
            r.event_type,
            EVENT_LABELS.get(r.event_type, r.event_type),
            r.device_id or "",
            r.status,
            r.actor,
            r.description,
        ])
    return buf.getvalue()


def summary_csv(summary: dict) -> str:
    import csv
    import io

    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["section", "key", "value", "note"])
    w.writerow(["meta", "source", summary["source"], "simulated" if summary["simulated"] else "measured"])
    for cls, count in summary["classification_counts"].items():
        w.writerow(["predictions", cls, count, ""])
    for day in summary["detections_over_time"]:
        w.writerow(["detections", day["date"], day["count"], f"avg_confidence={day['avg_confidence']}"])
    cs = summary["cleaning_stats"]
    for key in ("cycles", "failed", "aborted", "avg_duration_s", "water_l", "energy_wh", "repeated_24h", "success_rate_pct"):
        w.writerow(["cleaning", key, cs[key], cs["success_criterion"] if key == "success_rate_pct" else ""])
    pr = summary["power_recovery"]
    w.writerow(["power_recovery", "avg_delta_pct", pr["avg_delta_pct"], pr["note"]])
    w.writerow(["power_recovery", "estimated_recovered_wh", pr["estimated_recovered_wh"], "estimate unless noted"])
    for row in summary["power_before_after"]:
        w.writerow(["cycle", row["id"], row["delta_pct"], f"{row['before_w']}W -> {row['after_w']}W @ {row['when']}"])
    for row in summary["energy_series"]:
        w.writerow(["energy", row["date"], row["wh"], "Wh (integrated from samples)"])
    mm = summary["model_metrics"]
    w.writerow(["model_metrics", "available", mm["available"], mm["note"]])
    if mm["available"]:
        for key in ("accuracy", "precision", "recall", "f1", "support"):
            w.writerow(["model_metrics", key, mm[key], ""])
    return buf.getvalue()


def parse_json_field(raw: str, default: object) -> object:
    try:
        return json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        return default


def default_range(days: int = 7) -> tuple[datetime, datetime]:
    end = datetime.now(timezone.utc)
    return end - timedelta(days=days), end
