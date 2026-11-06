#!/usr/bin/env python3
"""Load-driven activation of a standby backend on the network load balancer.

Runs on the original application host. When this host's CPU stays high it clears
the second node's backup flag, so both nodes share traffic; when CPU stays low it
sets the flag again. See docs/decisions/0018-standby-activation-autoscaling.md.
"""

import argparse
import json
import math
import os
import signal
import sys
import threading
import time
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable, Mapping, NamedTuple, Optional, Sequence

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_CONFIG = 78  # Listed in RestartPreventExitStatus in the unit.

SCALE_OUT = "scale_out"
SCALE_IN = "scale_in"
NO_CHANGE = "none"
# Scaling out clears the backup flag; scaling in sets it.
TARGET_FLAG = {SCALE_OUT: False, SCALE_IN: True}

DEMO_SCALE_IN_WINDOW_SECONDS = 60.0

WORK_REQUEST_SUCCEEDED = "SUCCEEDED"
WORK_REQUEST_FAILED_STATES = ("FAILED", "CANCELED")
WORK_REQUEST_HEADER = "opc-work-request-id"

# The field names of the log line. docs/deployment.md documents them.
LOG_FIELDS = (
    "time",
    "mode",
    "cpu",
    "scale_out_mean",
    "scale_in_mean",
    "scale_out_window_full",
    "scale_in_window_full",
    "flag",
    "backend_health",
    "decision",
    "reason",
    "api_result",
    "work_request_result",
    "error",
)


class ConfigError(Exception):
    """The environment is invalid. The message names the variable."""


class MetricError(Exception):
    """A CPU reading cannot be used."""


# Configuration


@dataclass(frozen=True)
class Config:
    nlb_id: str
    backend_set: str
    backend_name: str
    sample_seconds: float = 5.0
    scale_out_threshold: float = 0.70
    scale_out_window_seconds: float = 30.0
    scale_in_threshold: float = 0.30
    scale_in_window_seconds: float = 300.0
    cooldown_seconds: float = 120.0
    refresh_seconds: float = 30.0
    work_request_timeout_seconds: float = 120.0
    work_request_poll_seconds: float = 5.0
    backoff_base_seconds: float = 5.0
    backoff_max_seconds: float = 300.0

    @property
    def scale_out_samples(self) -> int:
        return round(self.scale_out_window_seconds / self.sample_seconds)

    @property
    def scale_in_samples(self) -> int:
        return round(self.scale_in_window_seconds / self.sample_seconds)


def _required(env: Mapping[str, str], name: str) -> str:
    value = env.get(name, "").strip()
    if not value:
        raise ConfigError(f"{name} is required")
    return value


def _number(env: Mapping[str, str], name: str, default: float) -> float:
    raw = env.get(name, "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        raise ConfigError(f"{name} must be a number, got {raw!r}") from None
    if not math.isfinite(value):
        raise ConfigError(f"{name} must be a finite number, got {raw!r}")
    return value


def _positive(env: Mapping[str, str], name: str, default: float) -> float:
    value = _number(env, name, default)
    if value <= 0:
        raise ConfigError(f"{name} must be greater than 0, got {value}")
    return value


def _threshold(env: Mapping[str, str], name: str, default: float) -> float:
    value = _number(env, name, default)
    if not 0 < value < 1:
        raise ConfigError(f"{name} must be between 0 and 1, got {value}")
    return value


def _check_window(name: str, window: float, sample: float) -> None:
    ratio = window / sample
    if ratio < 1 or abs(ratio - round(ratio)) > 1e-9:
        raise ConfigError(f"{name} must be a whole multiple of CONTROLLER_SAMPLE_SECONDS, got {window}")


def load_config(env: Mapping[str, str]) -> Config:
    defaults = Config("", "", "")
    profile = env.get("CONTROLLER_PROFILE", "").strip()
    if profile not in ("", "demo"):
        raise ConfigError(f"CONTROLLER_PROFILE must be empty or demo, got {profile!r}")
    scale_in_window_default = defaults.scale_in_window_seconds
    if profile == "demo":
        if env.get("CONTROLLER_SCALE_IN_WINDOW_SECONDS", "").strip():
            raise ConfigError("CONTROLLER_SCALE_IN_WINDOW_SECONDS cannot be set with CONTROLLER_PROFILE=demo")
        scale_in_window_default = DEMO_SCALE_IN_WINDOW_SECONDS

    config = Config(
        nlb_id=_required(env, "CONTROLLER_NLB_ID"),
        backend_set=_required(env, "CONTROLLER_BACKEND_SET"),
        backend_name=_required(env, "CONTROLLER_BACKEND_NAME"),
        sample_seconds=_positive(env, "CONTROLLER_SAMPLE_SECONDS", defaults.sample_seconds),
        scale_out_threshold=_threshold(env, "CONTROLLER_SCALE_OUT_THRESHOLD", defaults.scale_out_threshold),
        scale_out_window_seconds=_positive(env, "CONTROLLER_SCALE_OUT_WINDOW_SECONDS", defaults.scale_out_window_seconds),
        scale_in_threshold=_threshold(env, "CONTROLLER_SCALE_IN_THRESHOLD", defaults.scale_in_threshold),
        scale_in_window_seconds=_positive(env, "CONTROLLER_SCALE_IN_WINDOW_SECONDS", scale_in_window_default),
        cooldown_seconds=_positive(env, "CONTROLLER_COOLDOWN_SECONDS", defaults.cooldown_seconds),
        refresh_seconds=_positive(env, "CONTROLLER_REFRESH_SECONDS", defaults.refresh_seconds),
        work_request_timeout_seconds=_positive(env, "CONTROLLER_WORK_REQUEST_TIMEOUT_SECONDS", defaults.work_request_timeout_seconds),
        work_request_poll_seconds=_positive(env, "CONTROLLER_WORK_REQUEST_POLL_SECONDS", defaults.work_request_poll_seconds),
        backoff_base_seconds=_positive(env, "CONTROLLER_BACKOFF_BASE_SECONDS", defaults.backoff_base_seconds),
        backoff_max_seconds=_positive(env, "CONTROLLER_BACKOFF_MAX_SECONDS", defaults.backoff_max_seconds),
    )

    _check_window("CONTROLLER_SCALE_OUT_WINDOW_SECONDS", config.scale_out_window_seconds, config.sample_seconds)
    _check_window("CONTROLLER_SCALE_IN_WINDOW_SECONDS", config.scale_in_window_seconds, config.sample_seconds)
    # Activating the standby roughly halves this node's share of the load. A scale-in
    # threshold at or above half the scale-out threshold would scale in straight away.
    if not config.scale_in_threshold < config.scale_out_threshold / 2:
        raise ConfigError(
            f"CONTROLLER_SCALE_IN_THRESHOLD ({config.scale_in_threshold}) must be strictly below half of "
            f"CONTROLLER_SCALE_OUT_THRESHOLD ({config.scale_out_threshold})"
        )
    return config


# Signal


class CpuTimes(NamedTuple):
    user: int
    nice: int
    system: int
    idle: int
    iowait: int
    irq: int
    softirq: int
    steal: int


def parse_cpu_times(stat_text: str) -> CpuTimes:
    """Reads the aggregate cpu line. guest and guest_nice are already counted in user and nice."""
    for line in stat_text.splitlines():
        fields = line.split()
        if fields and fields[0] == "cpu":
            try:
                return CpuTimes(*(int(value) for value in fields[1:9]))
            except (TypeError, ValueError):
                raise MetricError("malformed cpu line in /proc/stat") from None
    raise MetricError("no aggregate cpu line in /proc/stat")


def read_cpu_times(path: str = "/proc/stat") -> CpuTimes:
    with open(path, encoding="ascii") as stat_file:
        return parse_cpu_times(stat_file.read())


def utilization(previous: CpuTimes, current: CpuTimes) -> float:
    deltas = CpuTimes(*(now - before for now, before in zip(current, previous)))
    if any(delta < 0 for delta in deltas):
        raise MetricError("a /proc/stat counter went backwards")
    total = sum(deltas)
    if total == 0:
        raise MetricError("no /proc/stat time elapsed between samples")
    return 1 - (deltas.idle + deltas.iowait) / total


# Decision


@dataclass(frozen=True)
class Decision:
    action: str
    reason: str
    scale_out_mean: Optional[float]
    scale_in_mean: Optional[float]
    scale_out_full: bool
    scale_in_full: bool


def _window(samples: Sequence[float], size: int) -> tuple[Optional[float], bool]:
    recent = list(samples)[-size:]
    mean = math.fsum(recent) / len(recent) if recent else None
    return mean, len(recent) >= size


def decide(samples: Sequence[float], now: float, last_change_at: Optional[float], config: Config) -> Decision:
    """Pure decision. samples holds only samples taken after the last change, oldest first."""
    out_mean, out_full = _window(samples, config.scale_out_samples)
    in_mean, in_full = _window(samples, config.scale_in_samples)

    def result(action: str, reason: str) -> Decision:
        return Decision(action, reason, out_mean, in_mean, out_full, in_full)

    if last_change_at is not None and now - last_change_at < config.cooldown_seconds:
        return result(NO_CHANGE, "cooldown")
    if out_full and out_mean >= config.scale_out_threshold:
        return result(SCALE_OUT, "scale_out_threshold")
    if in_full and in_mean <= config.scale_in_threshold:
        return result(SCALE_IN, "scale_in_threshold")
    if not (out_full and in_full):
        return result(NO_CHANGE, "partial_window")
    return result(NO_CHANGE, "within_thresholds")


# Actuator


class Reading(NamedTuple):
    is_backup: bool
    weight: Optional[int]
    is_drain: bool
    is_offline: bool
    health: Optional[str]


class ChangeResult(NamedTuple):
    api_result: str  # updated, failed, timeout or interrupted
    work_request_result: Optional[str]
    error: Optional[str] = None

    @property
    def succeeded(self) -> bool:
        return self.api_result == "updated"


class OciApi:
    """The only code that touches the SDK. Authenticates with instance principals."""

    def __init__(self) -> None:
        import oci

        signer = oci.auth.signers.InstancePrincipalsSecurityTokenSigner()
        client = oci.network_load_balancer.NetworkLoadBalancerClient(
            config={},
            signer=signer,
            timeout=(10, 30),
            retry_strategy=oci.retry.NoneRetryStrategy(),
        )
        self.get_backend = client.get_backend
        self.get_backend_health = client.get_backend_health
        self.update_backend = client.update_backend
        self.get_work_request = client.get_work_request
        self.update_details = oci.network_load_balancer.models.UpdateBackendDetails


class Actuator:
    """Reads and changes one backend: the second node's. It holds no other backend's name."""

    def __init__(
        self,
        config: Config,
        api_factory: Callable[[], object] = OciApi,
        clock: Callable[[], float] = time.monotonic,
        wait: Callable[[float], bool] = time.sleep,
    ) -> None:
        self._config = config
        self._api_factory = api_factory
        self._api = None
        self._clock = clock
        self._wait = wait  # Returns true when the process is stopping.

    @property
    def api(self):
        if self._api is None:
            self._api = self._api_factory()
        return self._api

    def _address(self) -> tuple[str, str, str]:
        return self._config.nlb_id, self._config.backend_set, self._config.backend_name

    def read(self) -> Reading:
        backend = self.api.get_backend(*self._address()).data
        health = self.api.get_backend_health(*self._address()).data
        return Reading(backend.is_backup, backend.weight, backend.is_drain, backend.is_offline, health.status)

    def change(self, target: bool, reading: Reading) -> ChangeResult:
        """Sends is_backup with the other three fields as just read, then confirms the result."""
        nlb_id, backend_set, backend_name = self._address()
        details = self.api.update_details(
            is_backup=target,
            weight=reading.weight,
            is_drain=reading.is_drain,
            is_offline=reading.is_offline,
        )
        response = self.api.update_backend(nlb_id, details, backend_set, backend_name)
        work_request_id = response.headers.get(WORK_REQUEST_HEADER)

        deadline = self._clock() + self._config.work_request_timeout_seconds
        status = None
        last_error = None
        while True:
            try:
                if work_request_id is not None:
                    status = self.api.get_work_request(work_request_id).data.status
                flag = self.api.get_backend(*self._address()).data.is_backup
            except Exception as exc:
                last_error = describe_error(exc)
            else:
                last_error = None
                if status in WORK_REQUEST_FAILED_STATES:
                    return ChangeResult("failed", status, f"work request ended as {status}")
                if flag == target and (work_request_id is None or status == WORK_REQUEST_SUCCEEDED):
                    return ChangeResult("updated", status)
            remaining = deadline - self._clock()
            if remaining <= 0:
                error = last_error or f"is_backup not confirmed within {self._config.work_request_timeout_seconds} s"
                return ChangeResult("timeout", status, error)
            if self._wait(min(self._config.work_request_poll_seconds, remaining)):
                return ChangeResult("interrupted", status, "stopped while confirming the change")


def describe_error(exc: BaseException) -> str:
    """Logs the type, status and code only: the log is evidence, and API messages can hold OCIDs."""
    parts = [type(exc).__name__]
    for attribute in ("status", "code"):
        value = getattr(exc, attribute, None)
        if value is not None:
            parts.append(str(value))
    return " ".join(parts)


# Controller


class Controller:
    """One tick samples, decides and acts. Any error leaves the flag as it is."""

    def __init__(
        self,
        config: Config,
        actuator: Actuator,
        read_stat: Callable[[], CpuTimes] = read_cpu_times,
        clock: Callable[[], float] = time.monotonic,
        emit: Callable[[dict], None] = None,
        mode: str = "run",
    ) -> None:
        self.config = config
        self.actuator = actuator
        self.read_stat = read_stat
        self.clock = clock
        self.emit = emit or emit_json
        self.mode = mode
        self.read_only = mode != "run"
        self.samples: deque[float] = deque(maxlen=max(config.scale_out_samples, config.scale_in_samples))
        self.baseline: Optional[CpuTimes] = None
        self.last_change_at: Optional[float] = None
        self.flag: Optional[bool] = None
        self.flag_confirmed = False
        self.next_refresh_at = -math.inf
        self.next_api_at = -math.inf
        self.api_failures = 0

    def prime(self) -> None:
        """Takes the first /proc/stat reading, so the next tick has a delta."""
        self.baseline = self.read_stat()

    def tick(self) -> dict:
        now = self.clock()
        record = dict.fromkeys(LOG_FIELDS)
        record["time"] = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
        record["mode"] = self.mode

        skipped = self._sample(record)
        decision = decide(self.samples, now, self.last_change_at, self.config)
        record["scale_out_mean"] = _rounded(decision.scale_out_mean)
        record["scale_in_mean"] = _rounded(decision.scale_in_mean)
        record["scale_out_window_full"] = decision.scale_out_full
        record["scale_in_window_full"] = decision.scale_in_full
        record["decision"] = NO_CHANGE if skipped else decision.action
        record["reason"] = skipped or decision.reason

        self._use_api(record, now, TARGET_FLAG.get(record["decision"]))
        record["flag"] = self.flag
        self.emit(record)
        return record

    def _sample(self, record: dict) -> Optional[str]:
        """Adds one sample. Returns why the tick cannot decide, or None."""
        previous = self.baseline
        try:
            self.baseline = self.read_stat()
            if previous is None:
                return "no_baseline"
            cpu = utilization(previous, self.baseline)
        except Exception as exc:
            _add_error(record, str(exc) if isinstance(exc, MetricError) else describe_error(exc))
            return "metric_error"
        self.samples.append(cpu)
        record["cpu"] = _rounded(cpu)
        return None

    def _use_api(self, record: dict, now: float, target: Optional[bool]) -> None:
        refresh_due = now >= self.next_refresh_at
        already_there = target is not None and self.flag_confirmed and self.flag == target
        if not refresh_due and (target is None or already_there):
            if already_there:
                record["api_result"] = "noop"
            return
        if now < self.next_api_at:
            record["api_result"] = "backoff"
            return
        try:
            reading = self.actuator.read()
            record["backend_health"] = reading.health
            self.next_refresh_at = now + self.config.refresh_seconds
            if self._observe(reading.is_backup, now):
                record["decision"] = NO_CHANGE
                record["reason"] = "flag_changed"
                record["api_result"] = "read"
            elif target is None:
                record["api_result"] = "read"
            elif reading.is_backup == target:
                record["api_result"] = "noop"
            elif self.read_only:
                record["api_result"] = "dry_run"
            else:
                self._change(record, target, reading)
                return
            self.api_failures = 0
        except Exception as exc:
            record["api_result"] = "error"
            _add_error(record, describe_error(exc))
            self._api_failed()

    def _observe(self, flag: bool, now: float) -> bool:
        """Records a read. A flag that moved without a confirmed change counts as a change."""
        changed = self.flag is not None and flag != self.flag
        self.flag = flag
        self.flag_confirmed = True
        if changed:
            self._changed(now)
        return changed

    def _change(self, record: dict, target: bool, reading: Reading) -> None:
        result = self.actuator.change(target, reading)
        record["api_result"] = result.api_result
        record["work_request_result"] = result.work_request_result
        if result.succeeded:
            self.flag = target
            self.flag_confirmed = True
            self.api_failures = 0
            self._changed(self.clock())
        else:
            _add_error(record, result.error)
            self._api_failed()

    def _changed(self, now: float) -> None:
        self.samples.clear()
        self.last_change_at = now

    def _api_failed(self) -> None:
        self.flag_confirmed = False
        self.api_failures += 1
        delay = self.config.backoff_base_seconds * 2 ** min(self.api_failures - 1, 30)
        self.next_api_at = self.clock() + min(delay, self.config.backoff_max_seconds)


def _add_error(record: dict, message: str) -> None:
    record["error"] = f"{record['error']}; {message}" if record["error"] else message


def _rounded(value: Optional[float]) -> Optional[float]:
    return None if value is None else round(value, 4)


def emit_json(record: dict) -> None:
    print(json.dumps(record), flush=True)


def run(controller: Controller, stop: threading.Event) -> None:
    next_tick = controller.clock()
    while not stop.is_set():
        try:
            controller.tick()
        except Exception as exc:
            print(f"controller: tick failed: {describe_error(exc)}", file=sys.stderr, flush=True)
        next_tick = max(next_tick + controller.config.sample_seconds, controller.clock())
        stop.wait(max(0.0, next_tick - controller.clock()))


def run_once(controller: Controller, stop: threading.Event) -> int:
    try:
        controller.prime()
    except Exception as exc:
        print(f"controller: {describe_error(exc)}", file=sys.stderr)
        return EXIT_ERROR
    stop.wait(controller.config.sample_seconds)
    record = controller.tick()
    return EXIT_OK if record["cpu"] is not None and record["flag"] is not None else EXIT_ERROR


def install_signal_handlers(stop: threading.Event) -> None:
    def handle(_signum, _frame) -> None:
        stop.set()

    signal.signal(signal.SIGTERM, handle)
    signal.signal(signal.SIGINT, handle)


def main(argv: Optional[Sequence[str]] = None, env: Optional[Mapping[str, str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Load-driven activation of a standby backend.")
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--once", action="store_true", help="print one reading and decision; change nothing")
    modes.add_argument("--dry-run", action="store_true", help="loop, decide and log; never call update")
    args = parser.parse_args(argv)

    try:
        config = load_config(os.environ if env is None else env)
    except ConfigError as exc:
        print(f"controller: {exc}", file=sys.stderr)
        return EXIT_CONFIG

    stop = threading.Event()
    install_signal_handlers(stop)
    actuator = Actuator(config, wait=stop.wait)
    mode = "once" if args.once else "dry_run" if args.dry_run else "run"
    controller = Controller(config, actuator, mode=mode)
    if args.once:
        return run_once(controller, stop)
    run(controller, stop)
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
