"""AI endpoints: model info, image validation, inference, history and labels."""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile
from PIL import Image
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..database import get_db
from ..models import AiPrediction, Device, GroundTruthLabel, PanelImage, User
from ..schemas import ConfirmRequest, PredictionOut, PredictResponse
from ..security import CurrentUser, require_operator
from ..services import decision_engine
from ..services.events import log_event
from ..services.image_gen import generate_panel_image
from ..services.inference import (
    CLASS_LABELS,
    classifier,
    demo_heuristic,
    detect_image_format,
    open_and_validate_image,
    sha256_of,
)
from ..services.settings_service import load_settings
from ..services.system_service import resolve_device_id

logger = logging.getLogger("soilingguard.ai")
router = APIRouter(prefix="/api/ai", tags=["ai"])
settings = get_settings()

MEDIA_ROOT = Path(settings.media_dir)
RECOMMENDATIONS = {
    "clean": "No cleaning required. Continue routine monitoring.",
    "lightly_dusty": "Light soiling detected. Schedule cleaning during the next low-irradiance window.",
    "heavily_dusty": "Heavy soiling detected. Cleaning is recommended; verify with electrical measurements before acting.",
    "bird_dropping": "Localized contamination (bird droppings) detected. Spot cleaning is recommended.",
}


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _save_jpeg(image: Image.Image, rel_dir: str, name: str) -> tuple[str, str, int]:
    """Re-encode to JPEG (sanitises payloads) and return (abs_path, url, size)."""
    target_dir = MEDIA_ROOT / rel_dir
    target_dir.mkdir(parents=True, exist_ok=True)
    path = target_dir / name
    image.save(path, format="JPEG", quality=88, optimize=True)
    return str(path), f"/media/{rel_dir}/{name}", path.stat().st_size


def _prediction_out(p: AiPrediction, db: Session | None = None) -> dict:
    try:
        probabilities = json.loads(p.probabilities_json or "{}")
    except json.JSONDecodeError:
        probabilities = {}
    image = _image_cache.get(p.image_id) if p.image_id else None
    if image is None and db is not None and p.image_id:
        image = db.get(PanelImage, p.image_id)
        if image is not None:
            _cache_image(db, image)
    return PredictionOut(
        id=p.id,
        image_id=p.image_id or "",
        image_url=image.url if image else "",
        predicted_class=p.predicted_class,
        predicted_label=CLASS_LABELS.get(p.predicted_class, p.predicted_class),
        confidence=p.confidence,
        probabilities=probabilities,
        model_name=p.model_name,
        model_version=p.model_version,
        inference_ms=p.inference_ms,
        captured_at=_aware(image.captured_at) if image else _aware(p.created_at),
        created_at=_aware(p.created_at),
        source=p.source,
        recommendation=p.recommendation,
        demo=p.demo,
        confirmed_class=p.confirmed_class,
        gradcam_url=p.gradcam_path,
        quality_warnings=[w for w in (p.quality_warnings or "").split(";") if w],
    ).model_dump(mode="json")


_image_cache: dict[str, PanelImage] = {}


def _cache_image(db: Session, image: PanelImage) -> None:
    _image_cache[image.id] = image
    if len(_image_cache) > 512:
        _image_cache.clear()


@router.get("/model")
def model_info(_: CurrentUser):
    return classifier.info


@router.post("/predict", response_model=PredictResponse)
async def predict(
    request: Request,
    _: CurrentUser,
    file: UploadFile = File(...),
    device_id: str | None = Form(default=None),
    demo: int = Query(default=0),
    db: Session = Depends(get_db),
):
    from ..security import rate_limit

    rate_limit(request, "predict", settings.predict_rate_limit_per_minute, 60)

    data = await file.read()
    if len(data) > settings.max_upload_mb * 1024 * 1024:
        raise HTTPException(status_code=413, detail=f"Image exceeds the {settings.max_upload_mb} MB limit.")
    if not data:
        raise HTTPException(status_code=400, detail="The uploaded file is empty.")
    if detect_image_format(data) == "UNKNOWN":
        raise HTTPException(status_code=400, detail="Unsupported file type. Upload a JPEG or PNG image (magic bytes checked).")
    try:
        image = open_and_validate_image(data)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None

    cfg = load_settings(db)
    demo_mode = bool(cfg.get("demo_mode", True))
    use_demo = bool(demo) or not classifier.available
    if not use_demo and not classifier.available:  # pragma: no cover - guarded above
        raise HTTPException(status_code=503, detail="Model is not available.")

    resolved_device = resolve_device_id(db, device_id)

    # --------------------------- persist image ------------------------
    digest = sha256_of(data)
    rel_dir = "uploads"
    filename = f"{digest[:32]}.jpg"
    abs_path, url, size = _save_jpeg(image, rel_dir, filename)
    row = PanelImage(
        device_id=resolved_device,
        filename=filename,
        path=abs_path,
        url=url,
        source="upload",
        uploaded_by="api",
        sha256=digest,
        size_bytes=size,
        width=image.width,
        height=image.height,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    _cache_image(db, row)
    log_event(
        db,
        "image_captured",
        f"Panel image uploaded ({image.width}x{image.height}, {size // 1024} KB).",
        device_id=resolved_device,
        actor="api",
        reference=row.id,
    )
    result = demo_heuristic(image) if use_demo else classifier.predict(image)

    gradcam_url = None
    if result.gradcam is not None and settings.gradcam_enabled:
        try:
            from PIL import Image as PILImage

            gc_dir = MEDIA_ROOT / "gradcam"
            gc_dir.mkdir(parents=True, exist_ok=True)
            arr = (result.gradcam * 255).clip(0, 255).astype("uint8")
            gc_path = gc_dir / f"{row.id}.png"
            PILImage.fromarray(arr).save(gc_path, format="PNG")
            gradcam_url = f"/media/gradcam/{row.id}.png"
        except Exception:  # pragma: no cover
            logger.warning("Grad-CAM could not be stored", exc_info=True)

    source = "demo" if result.demo else "measured"
    prediction = AiPrediction(
        image_id=row.id,
        device_id=resolved_device,
        predicted_class=result.predicted_class,
        confidence=float(result.confidence),
        probabilities_json=json.dumps(result.probabilities),
        model_name=result.model_name,
        model_version=result.model_version,
        inference_ms=result.inference_ms,
        recommendation=RECOMMENDATIONS.get(result.predicted_class, ""),
        source=source,
        demo=result.demo,
        gradcam_path=gradcam_url,
        quality_warnings="; ".join(result.warnings),
    )
    db.add(prediction)
    db.commit()
    db.refresh(prediction)
    _cache_image(db, row)

    log_event(
        db,
        "prediction_generated",
        (
            f"{'DEMO ' if result.demo else ''}prediction: {CLASS_LABELS.get(result.predicted_class)} "
            f"({result.confidence:.0%}) via {result.model_name}."
        ),
        device_id=resolved_device,
        actor="api",
        reference=prediction.id,
        status="info",
    )

    decision = None
    if resolved_device:
        try:
            decision = decision_engine.to_outcome(decision_engine.evaluate(db, resolved_device, persist=True))
        except Exception:  # pragma: no cover
            logger.exception("Decision evaluation after prediction failed")

    message = result.message
    if result.demo and demo_mode:
        message += " Demo mode is active for this deployment."
    return PredictResponse(
        prediction=_prediction_out(prediction, db),
        decision=decision,
        model_available=classifier.available,
        message=message,
    )


class CaptureRequest(BaseModel):
    device_id: str | None = None


@router.post("/capture")
def capture_image(
    payload: CaptureRequest,
    _: CurrentUser,
    db: Session = Depends(get_db),
):
    resolved = resolve_device_id(db, payload.device_id)
    if resolved is None:
        raise HTTPException(status_code=404, detail="No device is registered yet.")
    device = db.get(Device, resolved)
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found.")

    if not device.simulated:
        if device.camera_status != "ok":
            raise HTTPException(status_code=409, detail="Camera is not available on this device (camera_status not ok).")
        raise HTTPException(
            status_code=503,
            detail="No camera driver is configured for this hardware device in this build, so a live capture cannot be performed.",
        )

    # simulated camera: generate a clearly labelled demo image matching current soiling
    from ..services.demo_simulator import soiling_loss_pct

    loss = soiling_loss_pct(db, device.id, datetime.now(timezone.utc))
    variant = "bird" if device.id.endswith("-bird") else ("heavy" if loss >= 10 else "light" if loss >= 4 else "clean")
    image = generate_panel_image(loss_pct=loss, variant=variant)
    digest = sha256_of(_to_bytes(image))
    abs_path, url, size = _save_jpeg(image, "captures", f"{digest[:32]}.jpg")
    row = PanelImage(
        device_id=device.id,
        filename=f"{digest[:32]}.jpg",
        path=abs_path,
        url=url,
        source="demo",
        uploaded_by="simulated-camera",
        sha256=digest,
        size_bytes=size,
        width=image.width,
        height=image.height,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    _cache_image(db, row)
    log_event(
        db,
        "image_captured",
        f"Simulated camera capture ({image.width}x{image.height}) reflecting {loss:.1f}% modelled soiling loss. DEMO IMAGE.",
        device_id=device.id,
        status="info",
        actor="simulated-camera",
        reference=row.id,
    )
    return {"image_id": row.id, "image_url": row.url, "captured_at": row.captured_at, "source": "demo"}


def _to_bytes(image: Image.Image) -> bytes:
    import io

    buf = io.BytesIO()
    image.save(buf, format="JPEG", quality=88)
    return buf.getvalue()


@router.get("/predictions")
def list_predictions(
    _: CurrentUser,
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = Query(default=None),
    predicted_class: str | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=1000),
    db: Session = Depends(get_db),
):
    q = select(AiPrediction)
    if from_:
        q = q.where(AiPrediction.created_at >= datetime.fromisoformat(from_.replace("Z", "+00:00")))
    if to:
        q = q.where(AiPrediction.created_at <= datetime.fromisoformat(to.replace("Z", "+00:00")))
    if predicted_class:
        q = q.where(AiPrediction.predicted_class == predicted_class)
    total = db.execute(select(func.count()).select_from(q.subquery())).scalar_one()
    rows = db.execute(
        q.order_by(AiPrediction.created_at.desc()).offset((page - 1) * page_size).limit(page_size)
    ).scalars().all()
    for r in rows:
        if r.image_id and r.image_id not in _image_cache:
            img = db.get(PanelImage, r.image_id)
            if img:
                _cache_image(db, img)
    return {"items": [_prediction_out(r, db) for r in rows], "total": total, "page": page, "page_size": page_size}


@router.post("/predictions/{prediction_id}/confirm", response_model=PredictionOut)
def confirm_prediction(
    prediction_id: str,
    payload: ConfirmRequest,
    request: Request,
    operator: User = Depends(require_operator),
    db: Session = Depends(get_db),
):
    if payload.confirmed_class not in CLASS_LABELS:
        raise HTTPException(status_code=400, detail=f"Unknown class '{payload.confirmed_class}'.")
    prediction = db.get(AiPrediction, prediction_id)
    if prediction is None:
        raise HTTPException(status_code=404, detail="Prediction not found.")
    prediction.confirmed_class = payload.confirmed_class
    db.commit()
    db.refresh(prediction)

    if prediction.image_id:
        existing = db.execute(
            select(GroundTruthLabel).where(GroundTruthLabel.image_id == prediction.image_id)
        ).scalar_one_or_none()
        if existing is None:
            db.add(
                GroundTruthLabel(
                    image_id=prediction.image_id,
                    label=payload.confirmed_class,
                    labeled_by=operator.username,
                )
            )
        else:
            existing.label = payload.confirmed_class
            existing.labeled_by = operator.username
        db.commit()
        img = db.get(PanelImage, prediction.image_id)
        if img:
            _cache_image(db, img)

    from ..security import audit

    audit(db, operator.username, "prediction_confirmed", prediction.id, payload.confirmed_class, request)
    log_event(
        db,
        "prediction_generated",
        f"Prediction {prediction.id[:8]} confirmed as '{payload.confirmed_class}' by {operator.username} (stored as ground-truth label).",
        device_id=prediction.device_id,
        actor=operator.username,
        reference=prediction.id,
    )
    return _prediction_out(prediction, db)


@router.delete("/images/{image_id}")
def delete_image(
    image_id: str,
    request: Request,
    operator: User = Depends(require_operator),
    db: Session = Depends(get_db),
):
    image = db.get(PanelImage, image_id)
    if image is None:
        raise HTTPException(status_code=404, detail="Image not found.")
    device_id = image.device_id
    path = Path(image.path)
    linked = db.execute(select(AiPrediction).where(AiPrediction.image_id == image_id)).scalars().all()
    for pred in linked:
        db.delete(pred)
    db.delete(image)
    db.commit()
    _image_cache.pop(image_id, None)
    try:
        if path.exists() and path.is_relative_to(MEDIA_ROOT):
            path.unlink()
    except OSError:  # pragma: no cover
        logger.warning("Could not remove image file %s", path, exc_info=True)
    from ..security import audit

    audit(db, operator.username, "image_deleted", image_id, f"removed with {len(linked)} linked prediction(s)", request)
    log_event(
        db,
        "image_captured",
        f"Image {image_id[:8]} deleted by {operator.username} ({len(linked)} prediction(s) removed with it).",
        device_id=device_id,
        status="warning",
        actor=operator.username,
    )
    return {"ok": True, "detail": "Image deleted."}
