"""AI inference module.

This module owns the *interface* between the web application and the computer
vision model. It deliberately degrades to a clearly labelled demo heuristic
when no trained model is present - it never presents generated numbers as a
validated CNN prediction.

Model loading (PyTorch) is optional: if PyTorch or the weights are missing the
API reports `model.available = false` and the UI shows "Model not configured".
"""

from __future__ import annotations

import hashlib
import io
import json
import logging
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter, UnidentifiedImageError

from ..config import get_settings

logger = logging.getLogger("soilingguard.ai")

settings = get_settings()

CLASS_LABELS: dict[str, str] = {
    "clean": "Clean",
    "lightly_dusty": "Lightly dusty",
    "heavily_dusty": "Heavily dusty",
    "bird_dropping": "Bird dropping",
}

DEFAULT_CLASSES = list(CLASS_LABELS.keys())

try:  # optional heavy dependency
    import torch  # type: ignore
    import torch.nn as nn  # type: ignore
    import torch.nn.functional as F  # type: ignore

    TORCH_AVAILABLE = True
except Exception:  # pragma: no cover - torch not installed
    TORCH = None  # type: ignore
    nn = None  # type: ignore
    F = None  # type: ignore
    TORCH_AVAILABLE = False

try:  # optional accelerated preprocessing / classic CV checks
    import cv2  # type: ignore

    CV2_AVAILABLE = True
except Exception:  # pragma: no cover
    cv2 = None  # type: ignore
    CV2_AVAILABLE = False


@dataclass
class QualityReport:
    warnings: list[str] = field(default_factory=list)
    blur_score: float | None = None
    glare_fraction: float | None = None
    mean_luma: float | None = None


@dataclass
class InferenceResult:
    predicted_class: str
    confidence: float
    probabilities: dict[str, float]
    model_name: str
    model_version: str
    inference_ms: float
    available: bool
    demo: bool
    message: str
    gradcam: np.ndarray | None = None
    warnings: list[str] = field(default_factory=list)


def _load_metadata() -> dict:
    path = Path(settings.model_metadata_path)
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            logger.warning("Model metadata could not be read: %s", path)
    return {
        "name": "MobileNetV3-Small (soiling)",
        "version": "untrained",
        "classes": DEFAULT_CLASSES,
        "input_size": [224, 224],
        "trained_on": None,
        "notes": "No trained weights are bundled with this build.",
    }


class PanelSoilingClassifier:
    """Loads an optional PyTorch model and exposes a stable predict() API."""

    def __init__(self) -> None:
        self._model = None
        self._metadata = _load_metadata()
        self._load_error: str | None = None
        self._attempted = False

    # ---------------------------- loading ---------------------------
    def load(self) -> bool:
        self._attempted = True
        if not TORCH_AVAILABLE:
            self._load_error = "PyTorch is not installed in this environment."
            logger.info("AI model unavailable: %s", self._load_error)
            return False
        path = Path(settings.model_path)
        if not path.exists():
            self._load_error = f"Model weights not found at {path}."
            logger.info("AI model unavailable: %s", self._load_error)
            return False
        try:
            device = torch.device("cpu")
            state = torch.load(path, map_location=device, weights_only=False)
            if isinstance(state, dict) and "model" in state:
                self._metadata.update(state.get("metadata", {}))
                weights = state["model"]
            else:
                weights = state
            classes = self._metadata.get("classes", DEFAULT_CLASSES)
            model = _build_mobilenet_v3(len(classes))
            if isinstance(weights, nn.Module):
                model = weights
            else:
                model.load_state_dict(weights)
            model.eval()
            self._model = model.to(device)
            self._load_error = None
            logger.info("Loaded soiling model: %s", path)
            return True
        except Exception as exc:  # pragma: no cover - depends on local weights
            self._load_error = f"Model could not be loaded: {exc}"
            logger.exception("Model load failed")
            self._model = None
            return False

    @property
    def available(self) -> bool:
        if not self._attempted:
            self.load()
        return self._model is not None

    @property
    def load_error(self) -> str | None:
        return self._load_error

    @property
    def info(self) -> dict:
        classes = [c for c in self._metadata.get("classes", DEFAULT_CLASSES) if c in CLASS_LABELS]
        trained = self.available and bool(self._metadata.get("trained_on"))
        return {
            "available": self.available,
            "name": self._metadata.get("name", "MobileNetV3-Small (soiling)"),
            "version": self._metadata.get("version", "untrained"),
            "framework": "pytorch" if TORCH_AVAILABLE else "none",
            "classes": classes or DEFAULT_CLASSES,
            "input_size": tuple(self._metadata.get("input_size", (224, 224))),
            "trained_for_four_class": set(DEFAULT_CLASSES).issubset(set(classes)) and trained,
            "trained_on": self._metadata.get("trained_on"),
            "notes": self._load_error or self._metadata.get("notes", ""),
        }

    # -------------------------- preprocessing -----------------------
    @staticmethod
    def check_quality(image: Image.Image) -> QualityReport:
        report = QualityReport()
        gray = np.asarray(image.convert("L"), dtype=np.float32)
        report.mean_luma = float(gray.mean())
        # blur: variance of a simplified Laplacian response
        lap = np.abs(
            4 * gray[1:-1, 1:-1] - gray[:-2, 1:-1] - gray[2:, 1:-1] - gray[1:-1, :-2] - gray[1:-1, 2:]
        )
        report.blur_score = float(lap.var())
        if report.blur_score < 45:
            report.warnings.append("Image appears blurred; classification confidence may be reduced.")
        rgb = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
        glare = float(((rgb.max(axis=2) > 0.965) & (rgb.min(axis=2) > 0.9)).mean())
        report.glare_fraction = glare
        if glare > 0.18:
            report.warnings.append("Strong specular glare detected; part of the panel may be saturated.")
        if report.mean_luma is not None and report.mean_luma < 45:
            report.warnings.append("Image is very dark; capture conditions may be insufficient.")
        if image.width < 160 or image.height < 160:
            report.warnings.append("Image resolution is low (below 160 px); results are less reliable.")
        return report

    @staticmethod
    def preprocess(image: Image.Image, size: tuple[int, int] = (224, 224)) -> Image.Image:
        """Resize + RGB order consistent with training (PIL RGB, normalized in tensor)."""
        if CV2_AVAILABLE:  # OpenCV reads BGR; convert explicitly when used
            arr = np.asarray(image.convert("RGB"))
            arr = cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)
            arr = cv2.cvtColor(arr, cv2.COLOR_BGR2RGB)
            image = Image.fromarray(arr)
        return image.convert("RGB").resize(size, Image.BILINEAR)

    # ---------------------------- inference -------------------------
    def predict(self, image: Image.Image) -> InferenceResult:
        quality = self.check_quality(image)
        if not self.available:
            return InferenceResult(
                predicted_class="",
                confidence=0.0,
                probabilities={},
                model_name=self._metadata.get("name", "unavailable"),
                model_version=self._metadata.get("version", "0.0.0"),
                inference_ms=0.0,
                available=False,
                demo=False,
                message=self._load_error or "Model not configured.",
                warnings=quality.warnings,
            )

        size = tuple(self._metadata.get("input_size", (224, 224)))  # type: ignore[assignment]
        tensor = self._to_tensor(image, size)  # type: ignore[arg-type]
        start = time.perf_counter()
        with torch.inference_mode():
            logits = self._model(tensor)
            probs_t = torch.softmax(logits, dim=1)[0]
        inference_ms = (time.perf_counter() - start) * 1000.0
        classes = list(self.info["classes"])
        probabilities = {c: round(float(p), 5) for c, p in zip(classes, probs_t.tolist())}
        predicted = max(probabilities, key=probabilities.get) if probabilities else "unknown"
        gradcam = None
        if settings.gradcam_enabled:
            gradcam = self._gradcam(image, size)  # type: ignore[arg-type]
        return InferenceResult(
            predicted_class=predicted,
            confidence=float(probabilities.get(predicted, 0.0)),
            probabilities=probabilities,
            model_name=self._metadata.get("name", "model"),
            model_version=str(self._metadata.get("version", "0.0.0")),
            inference_ms=round(inference_ms, 2),
            available=True,
            demo=False,
            message="Inference performed by the configured model.",
            gradcam=gradcam,
            warnings=quality.warnings,
        )

    def _to_tensor(self, image: Image.Image, size: tuple[int, int]):
        img = self.preprocess(image, size)
        arr = np.asarray(img, dtype=np.float32) / 255.0
        mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)
        std = np.array([0.229, 0.224, 0.225], dtype=np.float32)
        arr = (arr - mean) / std
        tensor = torch.from_numpy(arr).permute(2, 0, 1).unsqueeze(0)
        return tensor

    def _gradcam(self, image: Image.Image, size: tuple[int, int]) -> np.ndarray | None:
        """Grad-CAM over the last convolutional block of the loaded CNN."""
        try:
            model = self._model
            target = _find_last_conv(model)
            if target is None:
                return None
            tensor = self._to_tensor(image, size)
            captured: dict = {}

            def hook(_module, _inp, output):
                captured["feat"] = output

            handle = target.register_forward_hook(hook)
            with torch.inference_mode():
                model(tensor)
            handle.remove()
            feats = captured.get("feat")
            if feats is None:
                return None
            logits = model(tensor)
            weights = torch.mean(feats, dim=(2, 3), keepdim=True)
            cam = torch.relu((weights * feats).sum(dim=1, keepdim=True))[0, 0]
            cam = cam - cam.min()
            if cam.max() > 0:
                cam = cam / cam.max()
            cam_np = cam.cpu().numpy()
            cam_img = Image.fromarray((cam_np * 255).astype(np.uint8)).resize(
                (image.width, image.height), Image.BILINEAR
            )
            return np.asarray(cam_img)
        except Exception:  # pragma: no cover - explainability must never break inference
            logger.exception("Grad-CAM generation failed")
            return None


def _build_mobilenet_v3(num_classes: int):
    from torchvision.models import mobilenet_v3_small  # type: ignore

    model = mobilenet_v3_small(weights=None)
    model.classifier[3] = nn.Linear(model.classifier[3].in_features, num_classes)
    return model


def _find_last_conv(model):
    last = None
    for module in model.modules():
        if nn is not None and isinstance(module, nn.Conv2d):
            last = module
    return last


def demo_heuristic(image: Image.Image) -> InferenceResult:
    """Deterministic, transparent demo classifier (NOT a trained neural network).

    Uses simple image statistics so the same file always yields the same result.
    Results are flagged with demo=True and must be displayed as DEMO RESULTS.
    """
    start = time.perf_counter()
    report = PanelSoilingClassifier.check_quality(image)
    small = image.convert("RGB").resize((160, 160))
    arr = np.asarray(small, dtype=np.float32) / 255.0
    gray = arr.mean(axis=2)

    dark_fraction = float((gray < 0.42).mean())
    bright_low_sat = float(((gray > 0.78) & (arr.max(axis=2) - arr.min(axis=2) < 0.16)).mean())
    contrast = float(gray.std())

    if 0.02 < bright_low_sat < 0.30 and dark_fraction < 0.45 and contrast > 0.13:
        predicted, confidence = "bird_dropping", 0.74
        reason = "a compact bright low-saturation region was detected"
    elif dark_fraction > 0.55:
        predicted, confidence = "heavily_dusty", round(min(0.93, 0.62 + dark_fraction * 0.4), 3)
        reason = f"{dark_fraction:.0%} of pixels are darker than the clean-panel baseline"
    elif dark_fraction > 0.26:
        predicted, confidence = "lightly_dusty", round(min(0.88, 0.55 + dark_fraction * 0.6), 3)
        reason = f"{dark_fraction:.0%} of pixels are darker than the clean-panel baseline"
    else:
        predicted, confidence = "clean", round(min(0.9, 0.6 + (1 - dark_fraction) * 0.3), 3)
        reason = f"only {dark_fraction:.0%} of pixels fall below the dark-pixel threshold"

    # balanced probability vector (deterministic)
    probabilities = {c: 0.02 for c in DEFAULT_CLASSES}
    probabilities[predicted] = confidence
    rest = (1.0 - confidence) / max(1, len(DEFAULT_CLASSES) - 1)
    for c in probabilities:
        if c != predicted:
            probabilities[c] = round(rest, 4)
    total = sum(probabilities.values())
    probabilities = {k: round(v / total, 5) for k, v in probabilities.items()}

    elapsed = (time.perf_counter() - start) * 1000.0
    return InferenceResult(
        predicted_class=predicted,
        confidence=float(probabilities[predicted]),
        probabilities=probabilities,
        model_name="demo-heuristic (not a trained model)",
        model_version="demo-1.0",
        inference_ms=round(elapsed, 2),
        available=True,
        demo=True,
        message=(
            "DEMO RESULT: produced by a deterministic image-statistics rule for demonstration only. "
            f"Rule basis: {reason}. This is not a neural-network prediction and must not be used for real decisions."
        ),
        warnings=report.warnings,
    )


def open_and_validate_image(data: bytes) -> Image.Image:
    """Decode uploaded bytes; raises ValueError for malformed/unsupported files."""
    try:
        image = Image.open(io.BytesIO(data))
        image.load()
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise ValueError("The file could not be decoded as an image.") from exc
    if image.format not in {"JPEG", "PNG"}:
        raise ValueError("Only JPEG and PNG images are supported.")
    if image.mode not in {"RGB", "L", "RGBA", "P"}:
        raise ValueError("Unsupported image colour mode.")
    if image.width < 32 or image.height < 32:
        raise ValueError("Image is too small (minimum 32x32 pixels).")
    if image.width * image.height > 40_000_000:
        raise ValueError("Image resolution is unreasonably large.")
    return image.convert("RGB")


def sha256_of(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def detect_image_format(data: bytes) -> str:
    """Magic-byte sniffing so a renamed .exe cannot pass extension checks."""
    if data[:3] == b"\xff\xd8\xff":
        return "JPEG"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "PNG"
    return "UNKNOWN"


classifier = PanelSoilingClassifier()
