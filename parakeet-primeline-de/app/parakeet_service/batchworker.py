"""Bounded asynchronous inference backends for CPU and GPU deployments."""
from __future__ import annotations

import asyncio
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any, Callable, List, Optional

from .config import (
    INFERENCE_WORKERS,
    MAX_MICRO_BATCH_SIZE,
    MICRO_BATCHING_ENABLED,
    MICRO_BATCH_WINDOW_MS,
    logger,
)

import numpy as np


@dataclass(slots=True)
class _InferenceJob:
    waveform: np.ndarray
    result_future: asyncio.Future[Any]


def _stop_executor(executor: ThreadPoolExecutor) -> None:
    executor.shutdown(wait=True, cancel_futures=True)


def _recognize_single(model_resolver: Callable[[], Any], waveform: np.ndarray):
    return model_resolver().recognize(waveform)


def _recognize_batch(
    model_resolver: Callable[[], Any], waveforms: List[np.ndarray]
) -> List[Any]:
    model = model_resolver()
    if len(waveforms) == 1:
        return [model.recognize(waveforms[0])]
    outcome = model.recognize(waveforms)
    if isinstance(outcome, list):
        return outcome
    if isinstance(outcome, tuple):
        return list(outcome)
    try:
        return list(outcome)
    except TypeError as exc:
        raise RuntimeError("model returned a non-iterable batched result") from exc


class ParallelInferencePool:
    """Parallel single-item ORT calls, optimized for CPU inference."""

    def __init__(self, model_resolver, *, workers: int = INFERENCE_WORKERS):
        self._model_resolver = model_resolver
        self._worker_count = max(1, workers)
        self._executor = ThreadPoolExecutor(
            max_workers=self._worker_count, thread_name_prefix="ort"
        )
        self._stopped = False
        logger.info("ParallelInferencePool started (workers=%d)", self._worker_count)

    async def start(self) -> None:
        return None

    async def stop(self) -> None:
        if self._stopped:
            return
        self._stopped = True
        await asyncio.to_thread(_stop_executor, self._executor)

    async def submit(self, waveform: np.ndarray) -> Any:
        if self._stopped:
            raise RuntimeError("inference pool is stopped")
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            self._executor, _recognize_single, self._model_resolver, waveform
        )

    async def submit_all(self, waveforms: List[np.ndarray]) -> List[Any]:
        if not waveforms:
            return []
        return list(
            await asyncio.gather(*(self.submit(waveform) for waveform in waveforms))
        )


class MicroBatchWorker:
    """Cross-request micro-batching, intended for GPU inference."""

    def __init__(
        self,
        model_resolver,
        *,
        max_batch: int = MAX_MICRO_BATCH_SIZE,
        window_ms: float = MICRO_BATCH_WINDOW_MS,
    ):
        self._model_resolver = model_resolver
        self._max_batch_size = max(1, max_batch)
        self._window_seconds = max(0.0, window_ms) / 1000.0
        self._job_queue: asyncio.Queue[_InferenceJob] = asyncio.Queue()
        self._consumer_task: Optional[asyncio.Task[None]] = None
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="ort")
        self._accepting_jobs = False

    async def start(self) -> None:
        if self._consumer_task is None or self._consumer_task.done():
            self._accepting_jobs = True
            self._consumer_task = asyncio.create_task(
                self._consume_queue(), name="micro_batch_worker"
            )
            logger.info(
                "MicroBatchWorker started (max_batch=%d window=%.1fms)",
                self._max_batch_size,
                self._window_seconds * 1000,
            )

    async def stop(self) -> None:
        self._accepting_jobs = False
        consumer = self._consumer_task
        self._consumer_task = None
        if consumer is not None:
            consumer.cancel()
            try:
                await consumer
            except asyncio.CancelledError:
                pass
        self._abort_queued_jobs(RuntimeError("batch worker stopped"))
        await asyncio.to_thread(_stop_executor, self._executor)

    def _create_job(self, waveform: np.ndarray) -> _InferenceJob:
        if not self._accepting_jobs:
            raise RuntimeError("batch worker is not running")
        result_future = asyncio.get_running_loop().create_future()
        return _InferenceJob(waveform=waveform, result_future=result_future)

    async def submit(self, waveform: np.ndarray) -> Any:
        job = self._create_job(waveform)
        await self._job_queue.put(job)
        return await job.result_future

    async def submit_all(self, waveforms: List[np.ndarray]) -> List[Any]:
        if not waveforms:
            return []
        jobs = [self._create_job(waveform) for waveform in waveforms]
        for job in jobs:
            await self._job_queue.put(job)
        return list(await asyncio.gather(*(job.result_future for job in jobs)))

    def _abort_queued_jobs(self, error: BaseException) -> None:
        while True:
            try:
                job = self._job_queue.get_nowait()
            except asyncio.QueueEmpty:
                return
            if not job.result_future.done():
                job.result_future.set_exception(error)
            self._job_queue.task_done()

    async def _consume_queue(self) -> None:
        loop = asyncio.get_running_loop()
        while True:
            first_job = await self._job_queue.get()
            batch = [first_job]
            deadline = time.monotonic() + self._window_seconds

            while len(batch) < self._max_batch_size:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                try:
                    batch.append(
                        await asyncio.wait_for(
                            self._job_queue.get(), timeout=remaining
                        )
                    )
                except asyncio.TimeoutError:
                    break

            try:
                recognitions = await loop.run_in_executor(
                    self._executor,
                    _recognize_batch,
                    self._model_resolver,
                    [job.waveform for job in batch],
                )
                if len(recognitions) != len(batch):
                    raise RuntimeError(
                        "batched inference returned "
                        f"{len(recognitions)} results for {len(batch)} inputs"
                    )
            except asyncio.CancelledError:
                error = RuntimeError("batch worker stopped during inference")
                for job in batch:
                    if not job.result_future.done():
                        job.result_future.set_exception(error)
                raise
            except Exception as exc:
                logger.exception("batch inference failed (size=%d)", len(batch))
                for job in batch:
                    if not job.result_future.done():
                        job.result_future.set_exception(exc)
            else:
                for job, recognition in zip(batch, recognitions):
                    if not job.result_future.done():
                        job.result_future.set_result(recognition)
            finally:
                for _job in batch:
                    self._job_queue.task_done()


def create_inference_backend(model_resolver):
    if MICRO_BATCHING_ENABLED:
        logger.info("Using MicroBatchWorker (cross-request micro-batching)")
        return MicroBatchWorker(model_resolver)
    logger.info("Using ParallelInferencePool (parallel single-item inference)")
    return ParallelInferencePool(model_resolver)
