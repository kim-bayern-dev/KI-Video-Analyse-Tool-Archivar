"""HTTP routes for the OpenAI-compatible transcription API."""
from __future__ import annotations

import asyncio
import math
import re
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Tuple

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, PlainTextResponse, Response

from .audio import decode_audio
from .chunker import extract_chunk_views, plan_chunk_ranges
from .config import (
    CPU_THREAD_LAYOUT,
    MAX_AUDIO_SECONDS,
    MAX_BATCH_BYTES,
    MAX_BATCH_FILES,
    MAX_REQUEST_CHUNKS,
    MAX_UPLOAD_BYTES,
    SAMPLE_RATE_HZ,
    SERVED_MODEL_NAME,
    UPLOAD_READ_CHUNK_BYTES,
    logger,
)
from .model import list_loaded_models

router = APIRouter()
_SUPPORTED_RESPONSE_FORMATS = {"json", "text", "srt", "vtt", "verbose_json"}


@dataclass(slots=True)
class _DecodedRequestAudio:
    waveform: Any
    chunk_ranges: List[Tuple[int, int]]
    chunk_views: List[Any]
    duration_seconds: float


class _AudioDurationLimitExceeded(ValueError):
    pass


def _normalize_transcript_text(text: str) -> str:
    if not text:
        return ""
    cleaned = text.replace("▁", " ").strip()
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned.replace(" '", "'")


def _format_srt_timestamp(seconds: float) -> str:
    total_ms = max(0, int(round(float(seconds) * 1000)))
    hours, remainder = divmod(total_ms, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, millis = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def _render_srt(segments: Sequence[Dict[str, Any]]) -> str:
    lines: List[str] = []
    index = 1
    for segment in segments:
        text = segment["segment"].strip()
        if not text:
            continue
        lines.extend(
            [
                str(index),
                f"{_format_srt_timestamp(segment['start'])} --> "
                f"{_format_srt_timestamp(segment['end'])}",
                text,
                "",
            ]
        )
        index += 1
    return "\n".join(lines)


def _render_vtt(segments: Sequence[Dict[str, Any]]) -> str:
    output = ["WEBVTT", ""]
    for segment in segments:
        text = segment["segment"].strip()
        if not text:
            continue
        start = _format_srt_timestamp(segment["start"]).replace(",", ".")
        end = _format_srt_timestamp(segment["end"]).replace(",", ".")
        output.extend([f"{start} --> {end}", text, ""])
    return "\n".join(output)


def _normalize_recognition_result(recognition: Any) -> Dict[str, Any]:
    text = _normalize_transcript_text(getattr(recognition, "text", str(recognition)))
    tokens = [str(token) for token in (getattr(recognition, "tokens", []) or [])]
    timestamps: List[float] = []
    for raw_value in list(getattr(recognition, "timestamps", []) or []):
        try:
            offset = float(raw_value)
        except (TypeError, ValueError):
            continue
        if math.isfinite(offset):
            timestamps.append(max(0.0, offset))
    return {"text": text, "tokens": tokens, "timestamps": timestamps}


def _require_supported_model(model_name: str) -> str:
    requested = (model_name or SERVED_MODEL_NAME).strip().lower()
    if requested != SERVED_MODEL_NAME:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unknown model {model_name!r}. This deployment serves only "
                f"{SERVED_MODEL_NAME!r}."
            ),
        )
    return SERVED_MODEL_NAME


def _normalize_response_format(response_format: str) -> str:
    normalized = (response_format or "json").strip().lower()
    if normalized not in _SUPPORTED_RESPONSE_FORMATS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported response_format {response_format!r}",
        )
    return normalized


async def _read_upload_within_limit(upload: UploadFile) -> bytes:
    if not upload or not upload.filename:
        raise HTTPException(status_code=400, detail="No file provided")
    declared_size = getattr(upload, "size", None)
    if declared_size is not None and declared_size > MAX_UPLOAD_BYTES:
        await upload.close()
        raise HTTPException(
            status_code=413,
            detail=f"File exceeds the {MAX_UPLOAD_BYTES} byte upload limit",
        )

    payload = bytearray()
    try:
        while True:
            chunk = await upload.read(UPLOAD_READ_CHUNK_BYTES)
            if not chunk:
                break
            payload.extend(chunk)
            if len(payload) > MAX_UPLOAD_BYTES:
                raise HTTPException(
                    status_code=413,
                    detail=f"File exceeds the {MAX_UPLOAD_BYTES} byte upload limit",
                )
    finally:
        await upload.close()
    if not payload:
        raise HTTPException(status_code=400, detail="Empty file")
    return bytes(payload)


def _decode_and_chunk(payload: bytes) -> _DecodedRequestAudio:
    waveform = decode_audio(payload)
    duration_seconds = float(waveform.size) / SAMPLE_RATE_HZ
    if duration_seconds <= 0:
        raise ValueError("decoded audio is empty")
    if duration_seconds > MAX_AUDIO_SECONDS:
        raise _AudioDurationLimitExceeded(
            f"audio duration {duration_seconds:.1f}s exceeds limit "
            f"{MAX_AUDIO_SECONDS:.1f}s"
        )
    chunk_ranges = plan_chunk_ranges(waveform)
    chunk_views = extract_chunk_views(waveform, chunk_ranges)
    if len(chunk_views) > MAX_REQUEST_CHUNKS:
        raise _AudioDurationLimitExceeded(
            f"audio produced {len(chunk_views)} chunks; limit is {MAX_REQUEST_CHUNKS}"
        )
    return _DecodedRequestAudio(
        waveform=waveform,
        chunk_ranges=chunk_ranges,
        chunk_views=chunk_views,
        duration_seconds=duration_seconds,
    )


async def _decode_and_chunk_in_pool(
    request: Request, payload: bytes
) -> _DecodedRequestAudio:
    loop = asyncio.get_running_loop()
    try:
        return await loop.run_in_executor(
            request.app.state.audio_pool, _decode_and_chunk, payload
        )
    except _AudioDurationLimitExceeded as exc:
        raise HTTPException(status_code=413, detail=str(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("audio decode/preprocessing failed")
        raise HTTPException(
            status_code=415, detail="Audio could not be decoded"
        ) from exc


def _merge_chunk_results(
    decoded: _DecodedRequestAudio, recognitions: Sequence[Any]
) -> Tuple[str, List[Dict[str, Any]], List[Dict[str, Any]]]:
    if len(recognitions) != len(decoded.chunk_ranges):
        raise RuntimeError(
            f"inference returned {len(recognitions)} results for "
            f"{len(decoded.chunk_ranges)} chunks"
        )

    segments: List[Dict[str, Any]] = []
    words: List[Dict[str, Any]] = []
    for (start_sample, end_sample), recognition in zip(
        decoded.chunk_ranges, recognitions
    ):
        chunk_start_seconds = start_sample / SAMPLE_RATE_HZ
        chunk_end_seconds = min(decoded.duration_seconds, end_sample / SAMPLE_RATE_HZ)
        normalized = _normalize_recognition_result(recognition)
        if not normalized["text"]:
            continue

        timestamps = normalized["timestamps"]
        segment_start = chunk_start_seconds
        if timestamps:
            segment_start = min(
                chunk_end_seconds, max(chunk_start_seconds, chunk_start_seconds + timestamps[0])
            )
        segment_end = max(segment_start, chunk_end_seconds)
        segments.append(
            {
                "start": segment_start,
                "end": segment_end,
                "segment": normalized["text"],
            }
        )

        for index, (token, timestamp) in enumerate(
            zip(normalized["tokens"], timestamps)
        ):
            word = token.replace("▁", " ").strip()
            if not word:
                continue
            word_start = min(
                chunk_end_seconds, max(chunk_start_seconds, chunk_start_seconds + timestamp)
            )
            if index + 1 < len(timestamps):
                word_end = chunk_start_seconds + timestamps[index + 1]
            else:
                word_end = segment_end
            word_end = min(chunk_end_seconds, max(word_start, word_end))
            words.append({"start": word_start, "end": word_end, "word": word})

    transcript_text = _normalize_transcript_text(
        " ".join(item["segment"] for item in segments)
    )
    return transcript_text, segments, words


async def _run_inference(request: Request, decoded: _DecodedRequestAudio):
    backend = request.app.state.inference_backend
    if backend is None or not getattr(request.app.state, "ready", False):
        raise HTTPException(status_code=503, detail="Model is not ready")
    return await backend.submit_all(decoded.chunk_views)


@router.get("/health")
def service_health(request: Request):
    ready = bool(getattr(request.app.state, "ready", False))
    return {
        "status": "healthy" if ready else "starting",
        "ready": ready,
        "models": [SERVED_MODEL_NAME],
        "loaded": list_loaded_models(),
        "default_model": SERVED_MODEL_NAME,
        "cpu": CPU_THREAD_LAYOUT,
    }


@router.get("/healthz")
def readiness_probe(request: Request):
    if not getattr(request.app.state, "ready", False):
        raise HTTPException(status_code=503, detail="not ready")
    return {"status": "ok"}


@router.post("/v1/audio/transcriptions")
async def transcribe_audio(
    request: Request,
    file: UploadFile = File(...),
    model: str = Form(SERVED_MODEL_NAME),
    response_format: str = Form("json"),
    timestamp_granularities: Optional[List[str]] = Form(
        None, alias="timestamp_granularities[]"
    ),
    timestamp_granularities_plain: Optional[List[str]] = Form(
        None, alias="timestamp_granularities"
    ),
    language: Optional[str] = Form(None),
    prompt: Optional[str] = Form(None),
    temperature: Optional[float] = Form(None),
):
    del language, prompt, temperature  # accepted for OpenAI client compatibility
    _require_supported_model(model)
    output_format = _normalize_response_format(response_format)
    payload = await _read_upload_within_limit(file)

    request_started = time.perf_counter()
    decoded = await _decode_and_chunk_in_pool(request, payload)
    decode_ms = (time.perf_counter() - request_started) * 1000

    inference_started = time.perf_counter()
    recognitions = await _run_inference(request, decoded)
    inference_ms = (time.perf_counter() - inference_started) * 1000
    transcript_text, segments, words = _merge_chunk_results(decoded, recognitions)

    logger.info(
        "transcribe model=%s dur=%.2fs chunks=%d decode=%.0fms infer=%.0fms total=%.0fms",
        SERVED_MODEL_NAME,
        decoded.duration_seconds,
        len(decoded.chunk_views),
        decode_ms,
        inference_ms,
        (time.perf_counter() - request_started) * 1000,
    )

    if output_format == "text":
        return PlainTextResponse(transcript_text)
    if output_format == "srt":
        return Response(_render_srt(segments), media_type="application/x-subrip")
    if output_format == "vtt":
        return Response(_render_vtt(segments), media_type="text/vtt")
    if output_format == "verbose_json":
        granularities = set(timestamp_granularities or []) | set(
            timestamp_granularities_plain or []
        )
        return JSONResponse(
            {
                "task": "transcribe",
                "language": "auto",
                "duration": decoded.duration_seconds,
                "text": transcript_text,
                "segments": [
                    {
                        "id": index,
                        "seek": 0,
                        "start": segment["start"],
                        "end": segment["end"],
                        "text": segment["segment"],
                        "tokens": [],
                        "temperature": 0.0,
                        "avg_logprob": 0.0,
                        "compression_ratio": 0.0,
                        "no_speech_prob": 0.0,
                    }
                    for index, segment in enumerate(segments)
                ],
                "words": words if "word" in granularities else None,
            }
        )
    return JSONResponse({"text": transcript_text})


@router.post("/v1/audio/transcriptions/batch")
async def transcribe_audio_batch(
    request: Request,
    files: List[UploadFile] = File(...),
    model: str = Form(SERVED_MODEL_NAME),
):
    if not files:
        raise HTTPException(status_code=400, detail="No files provided")
    if len(files) > MAX_BATCH_FILES:
        raise HTTPException(
            status_code=413,
            detail=f"Batch contains {len(files)} files; limit is {MAX_BATCH_FILES}",
        )
    _require_supported_model(model)
    filenames = [upload.filename or "unnamed" for upload in files]

    payloads: List[bytes] = []
    total_bytes = 0
    for upload in files:
        payload = await _read_upload_within_limit(upload)
        total_bytes += len(payload)
        if total_bytes > MAX_BATCH_BYTES:
            raise HTTPException(
                status_code=413,
                detail=f"Batch exceeds the {MAX_BATCH_BYTES} byte limit",
            )
        payloads.append(payload)

    loop = asyncio.get_running_loop()
    pending_decodes = [
        loop.run_in_executor(request.app.state.audio_pool, _decode_and_chunk, payload)
        for payload in payloads
    ]
    decoded_or_errors = await asyncio.gather(*pending_decodes, return_exceptions=True)
    decoded_files: List[_DecodedRequestAudio] = []
    for filename, outcome in zip(filenames, decoded_or_errors):
        if isinstance(outcome, _AudioDurationLimitExceeded):
            raise HTTPException(status_code=413, detail=f"{filename}: {outcome}")
        if isinstance(outcome, BaseException):
            logger.exception(
                "batch audio preprocessing failed for %s",
                filename,
                exc_info=(type(outcome), outcome, outcome.__traceback__),
            )
            raise HTTPException(
                status_code=415, detail=f"{filename}: audio could not be decoded"
            )
        decoded_files.append(outcome)

    total_chunks = sum(len(item.chunk_views) for item in decoded_files)
    if total_chunks > MAX_REQUEST_CHUNKS:
        raise HTTPException(
            status_code=413,
            detail=f"Batch produced {total_chunks} chunks; limit is {MAX_REQUEST_CHUNKS}",
        )

    flattened_views = [view for item in decoded_files for view in item.chunk_views]
    backend = request.app.state.inference_backend
    if backend is None or not getattr(request.app.state, "ready", False):
        raise HTTPException(status_code=503, detail="Model is not ready")
    flat_recognitions = await backend.submit_all(flattened_views)

    cursor = 0
    response_items = []
    for filename, decoded in zip(filenames, decoded_files):
        chunk_count = len(decoded.chunk_views)
        item_recognitions = flat_recognitions[cursor : cursor + chunk_count]
        cursor += chunk_count
        text, _segments, _words = _merge_chunk_results(decoded, item_recognitions)
        response_items.append(
            {"filename": filename, "text": text, "duration": decoded.duration_seconds}
        )

    if cursor != len(flat_recognitions):
        raise RuntimeError("inference result accounting mismatch")
    return {"results": response_items, "batch_size": len(response_items)}
