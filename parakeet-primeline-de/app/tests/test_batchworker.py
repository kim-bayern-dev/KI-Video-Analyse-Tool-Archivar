from __future__ import annotations

import asyncio

import numpy as np
import pytest

from parakeet_service.batchworker import MicroBatchWorker, ParallelInferencePool


class _FakeModel:
    def recognize(self, waveform):
        if isinstance(waveform, list):
            return [float(item.sum()) for item in waveform]
        return float(waveform.sum())


@pytest.mark.asyncio
async def test_inference_pool_runs_and_rejects_after_stop():
    pool = ParallelInferencePool(lambda: _FakeModel(), workers=2)
    results = await pool.submit_all(
        [np.ones(3, dtype=np.float32), np.ones(5, dtype=np.float32)]
    )
    assert results == [3.0, 5.0]
    await pool.stop()
    with pytest.raises(RuntimeError, match="stopped"):
        await pool.submit(np.ones(1, dtype=np.float32))


@pytest.mark.asyncio
async def test_micro_batch_worker_batches_jobs():
    worker = MicroBatchWorker(lambda: _FakeModel(), max_batch=4, window_ms=20)
    await worker.start()
    try:
        results = await worker.submit_all(
            [np.ones(2, dtype=np.float32), np.ones(4, dtype=np.float32)]
        )
        assert results == [2.0, 4.0]
    finally:
        await worker.stop()


@pytest.mark.asyncio
async def test_micro_batch_worker_matches_concurrent_results_in_order():
    worker = MicroBatchWorker(lambda: _FakeModel(), max_batch=4, window_ms=20)
    await worker.start()
    try:
        first, second = await asyncio.gather(
            worker.submit(np.ones(2, dtype=np.float32)),
            worker.submit(np.ones(3, dtype=np.float32)),
        )
        assert (first, second) == (2.0, 3.0)
    finally:
        await worker.stop()


@pytest.mark.asyncio
async def test_micro_batch_worker_rejects_submission_before_start():
    worker = MicroBatchWorker(lambda: _FakeModel(), max_batch=2, window_ms=0)
    with pytest.raises(RuntimeError, match="not running"):
        await worker.submit(np.ones(1, dtype=np.float32))
    await worker.stop()
