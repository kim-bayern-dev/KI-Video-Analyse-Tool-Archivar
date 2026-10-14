from __future__ import annotations

import threading
from dataclasses import replace

from segment_scenes.config import ModelOffloading, Settings
from segment_scenes.model_manager import ModelManager


class FakeCuda:
    def __init__(self, available: bool = True):
        self.available = available
        self.empty_cache_calls = 0

    def is_available(self) -> bool:
        return self.available

    def empty_cache(self) -> None:
        self.empty_cache_calls += 1


class FakeTorch:
    def __init__(self):
        self.cuda = FakeCuda()

    @staticmethod
    def device(value: str) -> str:
        return value


class FakeModel:
    def __init__(self, device: str):
        self.device = device
        self.moves = [device]
        self.eval_calls = 0

    def eval(self):
        self.eval_calls += 1
        return self

    def to(self, device: str):
        self.device = device
        self.moves.append(device)
        return self


def _manager(mode: ModelOffloading) -> tuple[ModelManager, FakeModel, FakeTorch]:
    settings = replace(Settings(), model_offloading=mode, device="cuda")
    fake_torch = FakeTorch()
    created: list[FakeModel] = []

    def factory(device: str) -> FakeModel:
        model = FakeModel(device)
        created.append(model)
        return model

    manager = ModelManager(settings, model_factory=factory, torch_module=fake_torch)
    manager.start()
    return manager, created[0], fake_torch


def test_never_keeps_one_model_in_vram():
    manager, model, _ = _manager(ModelOffloading.NEVER)

    with manager.model_session() as (leased, device):
        assert leased is model
        assert device == "cuda"

    assert manager.status()["model_in_vram"] is True
    assert model.moves == ["cuda"]


def test_immediate_moves_same_model_back_to_cpu():
    manager, model, fake_torch = _manager(ModelOffloading.IMMEDIATE)
    assert manager.status()["resident_device"] == "cpu"

    with manager.model_session() as (leased, device):
        assert leased is model
        assert device == "cuda"
        assert manager.status()["busy"] is True

    assert model.moves == ["cpu", "cuda", "cpu"]
    assert manager.status()["model_in_vram"] is False
    assert fake_torch.cuda.empty_cache_calls == 1


def test_timeout_schedules_offload_and_manual_offload_is_idempotent():
    manager, model, _ = _manager(ModelOffloading.TIMEOUT)

    with manager.model_session():
        pass

    assert manager.status()["offload_scheduled"] is True
    assert manager.offload_now() is True
    assert manager.offload_now() is False
    assert model.moves == ["cpu", "cuda", "cpu"]


def test_status_remains_available_during_long_model_session():
    manager, _, _ = _manager(ModelOffloading.NEVER)
    entered = threading.Event()
    release = threading.Event()

    def hold_session():
        with manager.model_session():
            entered.set()
            release.wait(timeout=2)

    worker = threading.Thread(target=hold_session)
    worker.start()
    assert entered.wait(timeout=1)

    status = manager.status()

    assert status["ready"] is True
    assert status["busy"] is True
    release.set()
    worker.join(timeout=1)
    assert not worker.is_alive()
