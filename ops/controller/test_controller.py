"""Unit tests. Standard library only: no SDK and no network."""

import contextlib
import io
import json
import os
import signal
import sys
import threading
import unittest
from types import SimpleNamespace
from unittest import mock

import controller as c

FIRST = "first-node-backend"
SECOND = "second-node-backend"
ENV = {
    "CONTROLLER_NLB_ID": "example-nlb",
    "CONTROLLER_BACKEND_SET": "example-set",
    "CONTROLLER_BACKEND_NAME": SECOND,
}


def config(**overrides):
    return c.Config("example-nlb", "example-set", SECOND, **overrides)


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now

    def wait(self, seconds):
        self.now += seconds
        return False


class Stat:
    """Produces /proc/stat readings for a chosen utilization, 100 jiffies per reading."""

    def __init__(self):
        self.busy = 0
        self.idle = 0
        self.level = 0.0
        self.error = None

    def __call__(self):
        if self.error:
            raise self.error
        self.busy += round(self.level * 100)
        self.idle += 100 - round(self.level * 100)
        return c.CpuTimes(self.busy, 0, 0, self.idle, 0, 0, 0, 0)


class FakeApi:
    """Stands in for the SDK. Holds both backends, so a wrong address changes the wrong record."""

    def __init__(self, is_backup=True, weight=7, is_drain=False, is_offline=True):
        self.backends = {
            FIRST: SimpleNamespace(is_backup=False, weight=1, is_drain=False, is_offline=False),
            SECOND: SimpleNamespace(is_backup=is_backup, weight=weight, is_drain=is_drain, is_offline=is_offline),
        }
        self.addressed = []
        self.updates = []
        self.work_request_ids = []
        self.apply_update = True
        self.work_request_status = "SUCCEEDED"
        self.work_request_header = True
        self.read_error = None
        self.update_error = None
        self.work_request_errors = 0

    def update_details(self, **fields):
        return dict(fields)

    def get_backend(self, nlb_id, backend_set, backend_name):
        self.addressed.append(("get_backend", nlb_id, backend_set, backend_name))
        if self.read_error:
            raise self.read_error
        return SimpleNamespace(data=SimpleNamespace(**vars(self.backends[backend_name])))

    def get_backend_health(self, nlb_id, backend_set, backend_name):
        self.addressed.append(("get_backend_health", nlb_id, backend_set, backend_name))
        return SimpleNamespace(data=SimpleNamespace(status="OK"))

    def update_backend(self, nlb_id, details, backend_set, backend_name):
        self.addressed.append(("update_backend", nlb_id, backend_set, backend_name))
        if self.update_error:
            raise self.update_error
        self.updates.append(details)
        if self.apply_update:
            vars(self.backends[backend_name]).update(details)
        headers = {c.WORK_REQUEST_HEADER: "example-work-request"} if self.work_request_header else {}
        return SimpleNamespace(headers=headers)

    def get_work_request(self, work_request_id):
        self.work_request_ids.append(work_request_id)
        if self.work_request_errors:
            self.work_request_errors -= 1
            raise OSError("connection reset")
        return SimpleNamespace(data=SimpleNamespace(status=self.work_request_status))


class Harness:
    def __init__(self, mode="run", api=None, **overrides):
        self.config = config(**overrides)
        self.clock = Clock()
        self.stat = Stat()
        self.api = api or FakeApi()
        self.records = []
        self.actuator = c.Actuator(self.config, lambda: self.api, clock=self.clock, wait=self.clock.wait)
        self.controller = self.new_controller(mode)

    def new_controller(self, mode="run"):
        return c.Controller(self.config, self.actuator, self.stat, self.clock, self.records.append, mode)

    def ticks(self, level, count):
        self.stat.level = level
        result = []
        for _ in range(count):
            result.append(self.controller.tick())
            self.clock.now += self.config.sample_seconds
        return result


class DecideTests(unittest.TestCase):
    def setUp(self):
        self.config = config()

    def decide(self, samples, now=1000.0, last_change_at=None):
        return c.decide(samples, now, last_change_at, self.config)

    def test_scales_out_at_the_threshold(self):
        self.assertEqual(self.decide([0.75] * 3 + [0.65] * 3).action, c.SCALE_OUT)

    def test_no_scale_out_just_below_the_threshold(self):
        self.assertEqual(self.decide([0.69] * 6).action, c.NO_CHANGE)

    def test_scales_in_at_the_threshold(self):
        self.assertEqual(self.decide([0.25] * 30 + [0.35] * 30).action, c.SCALE_IN)

    def test_no_scale_in_just_above_the_threshold(self):
        self.assertEqual(self.decide([0.31] * 60).action, c.NO_CHANGE)

    def test_hysteresis_band_changes_nothing(self):
        decision = self.decide([0.5] * 60)
        self.assertEqual((decision.action, decision.reason), (c.NO_CHANGE, "within_thresholds"))

    def test_scale_out_uses_only_the_last_30_seconds(self):
        self.assertEqual(self.decide([0.0] * 54 + [0.9] * 6).action, c.SCALE_OUT)

    def test_scale_out_wins_when_both_windows_trigger(self):
        decision = self.decide([0.0] * 54 + [0.9] * 6)
        self.assertLessEqual(decision.scale_in_mean, 0.30)
        self.assertEqual(decision.action, c.SCALE_OUT)

    def test_partial_scale_out_window_decides_nothing(self):
        decision = self.decide([1.0] * 5)
        self.assertEqual((decision.action, decision.reason), (c.NO_CHANGE, "partial_window"))
        self.assertFalse(decision.scale_out_full)

    def test_partial_scale_in_window_decides_nothing(self):
        decision = self.decide([0.0] * 59)
        self.assertEqual((decision.action, decision.reason), (c.NO_CHANGE, "partial_window"))
        self.assertTrue(decision.scale_out_full)
        self.assertFalse(decision.scale_in_full)

    def test_restart_with_an_empty_window_decides_nothing(self):
        decision = self.decide([])
        self.assertEqual(decision.action, c.NO_CHANGE)
        self.assertIsNone(decision.scale_out_mean)
        self.assertIsNone(decision.scale_in_mean)

    def test_cooldown_blocks_until_it_ends(self):
        self.assertEqual(self.decide([0.9] * 6, now=1119.0, last_change_at=1000.0).reason, "cooldown")
        self.assertEqual(self.decide([0.9] * 6, now=1120.0, last_change_at=1000.0).action, c.SCALE_OUT)

    def test_decide_does_not_change_its_input(self):
        samples = [0.9] * 6
        self.decide(samples)
        self.assertEqual(samples, [0.9] * 6)


class ValidationTests(unittest.TestCase):
    def test_defaults(self):
        loaded = c.load_config(ENV)
        self.assertEqual(
            (loaded.sample_seconds, loaded.scale_out_threshold, loaded.scale_out_window_seconds),
            (5.0, 0.70, 30.0),
        )
        self.assertEqual(
            (loaded.scale_in_threshold, loaded.scale_in_window_seconds, loaded.cooldown_seconds),
            (0.30, 300.0, 120.0),
        )
        self.assertEqual((loaded.scale_out_samples, loaded.scale_in_samples), (6, 60))

    def test_every_value_comes_from_the_environment(self):
        loaded = c.load_config({**ENV, "CONTROLLER_SCALE_OUT_THRESHOLD": "0.8", "CONTROLLER_COOLDOWN_SECONDS": "60"})
        self.assertEqual((loaded.scale_out_threshold, loaded.cooldown_seconds), (0.8, 60.0))

    def test_scale_in_exactly_half_is_refused(self):
        with self.assertRaisesRegex(c.ConfigError, "CONTROLLER_SCALE_IN_THRESHOLD"):
            c.load_config({**ENV, "CONTROLLER_SCALE_IN_THRESHOLD": "0.35"})

    def test_scale_in_above_half_is_refused(self):
        with self.assertRaisesRegex(c.ConfigError, "CONTROLLER_SCALE_IN_THRESHOLD"):
            c.load_config({**ENV, "CONTROLLER_SCALE_IN_THRESHOLD": "0.5"})

    def test_lower_scale_out_can_break_the_rule(self):
        with self.assertRaisesRegex(c.ConfigError, "CONTROLLER_SCALE_OUT_THRESHOLD"):
            c.load_config({**ENV, "CONTROLLER_SCALE_OUT_THRESHOLD": "0.6"})

    def test_scale_in_just_below_half_is_accepted(self):
        self.assertEqual(c.load_config({**ENV, "CONTROLLER_SCALE_IN_THRESHOLD": "0.34"}).scale_in_threshold, 0.34)

    def test_refused_rule_exits_non_zero_and_names_the_variable(self):
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr), mock.patch.object(c, "run") as loop:
            code = c.main([], {**ENV, "CONTROLLER_SCALE_IN_THRESHOLD": "0.35"})
        loop.assert_not_called()
        self.assertEqual(code, c.EXIT_CONFIG)
        self.assertIn("CONTROLLER_SCALE_IN_THRESHOLD", stderr.getvalue())

    def test_missing_required_values_are_named(self):
        for name in ENV:
            env = {key: value for key, value in ENV.items() if key != name}
            with self.assertRaisesRegex(c.ConfigError, name):
                c.load_config(env)

    def test_invalid_numbers_are_named(self):
        for value in ("abc", "nan", "inf"):
            with self.assertRaisesRegex(c.ConfigError, "CONTROLLER_SAMPLE_SECONDS"):
                c.load_config({**ENV, "CONTROLLER_SAMPLE_SECONDS": value})

    def test_threshold_must_be_a_fraction(self):
        with self.assertRaisesRegex(c.ConfigError, "CONTROLLER_SCALE_OUT_THRESHOLD"):
            c.load_config({**ENV, "CONTROLLER_SCALE_OUT_THRESHOLD": "70"})

    def test_window_must_be_a_multiple_of_the_sample_interval(self):
        with self.assertRaisesRegex(c.ConfigError, "CONTROLLER_SCALE_OUT_WINDOW_SECONDS"):
            c.load_config({**ENV, "CONTROLLER_SCALE_OUT_WINDOW_SECONDS": "32"})

    def test_demo_profile_changes_only_the_scale_in_window(self):
        demo = c.load_config({**ENV, "CONTROLLER_PROFILE": "demo"})
        normal = c.load_config(ENV)
        self.assertEqual(demo.scale_in_window_seconds, 60.0)
        self.assertEqual(vars(demo) | {"scale_in_window_seconds": 300.0}, vars(normal))

    def test_demo_profile_refuses_an_explicit_scale_in_window(self):
        with self.assertRaisesRegex(c.ConfigError, "CONTROLLER_SCALE_IN_WINDOW_SECONDS"):
            c.load_config({**ENV, "CONTROLLER_PROFILE": "demo", "CONTROLLER_SCALE_IN_WINDOW_SECONDS": "90"})

    def test_unknown_profile_is_refused(self):
        with self.assertRaisesRegex(c.ConfigError, "CONTROLLER_PROFILE"):
            c.load_config({**ENV, "CONTROLLER_PROFILE": "fast"})

    def test_example_env_file_loads_and_uses_the_defaults(self):
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "controller.env.example")
        with open(path, encoding="utf-8") as example:
            pairs = [line.strip().split("=", 1) for line in example if line.strip() and not line.startswith("#")]
        self.assertEqual(c.load_config(dict(pairs)).scale_in_window_seconds, 300.0)


class ParserTests(unittest.TestCase):
    LINE = "cpu  100 5 20 800 40 3 2 30 9 9\ncpu0 100 5 20 800 40 3 2 30 9 9\nintr 1\n"

    def test_reads_the_aggregate_line_without_guest_fields(self):
        self.assertEqual(c.parse_cpu_times(self.LINE), c.CpuTimes(100, 5, 20, 800, 40, 3, 2, 30))

    def test_ignores_per_cpu_lines(self):
        with self.assertRaises(c.MetricError):
            c.parse_cpu_times("cpu0 1 2 3 4 5 6 7 8\n")

    def test_refuses_a_short_or_malformed_line(self):
        for text in ("cpu 1 2 3\n", "cpu a b c d e f g h\n", ""):
            with self.assertRaises(c.MetricError):
                c.parse_cpu_times(text)

    def test_utilization_counts_idle_and_iowait_as_not_busy(self):
        before = c.CpuTimes(0, 0, 0, 0, 0, 0, 0, 0)
        after = c.CpuTimes(40, 5, 10, 25, 15, 2, 1, 2)
        self.assertAlmostEqual(c.utilization(before, after), 0.6)

    def test_counter_going_backwards_is_a_metric_error(self):
        before = c.CpuTimes(10, 0, 0, 10, 10, 0, 0, 0)
        after = c.CpuTimes(20, 0, 0, 20, 9, 0, 0, 0)
        with self.assertRaisesRegex(c.MetricError, "backwards"):
            c.utilization(before, after)

    def test_no_elapsed_time_is_a_metric_error(self):
        same = c.CpuTimes(1, 2, 3, 4, 5, 6, 7, 8)
        with self.assertRaises(c.MetricError):
            c.utilization(same, same)

    def test_reads_the_real_file_when_there_is_one(self):
        if os.path.exists("/proc/stat"):
            self.assertGreater(sum(c.read_cpu_times()), 0)


class ActuatorTests(unittest.TestCase):
    def scale_out(self, harness):
        return harness.ticks(0.9, 7)

    def test_a_never_addresses_the_first_node(self):
        harness = Harness()
        first_before = dict(vars(harness.api.backends[FIRST]))
        self.scale_out(harness)
        harness.clock.now += 200
        harness.ticks(0.1, 62)
        self.assertEqual(len(harness.api.updates), 2)
        self.assertEqual({call[1:] for call in harness.api.addressed}, {("example-nlb", "example-set", SECOND)})
        self.assertEqual(vars(harness.api.backends[FIRST]), first_before)

    def test_b_sends_all_four_fields_with_only_is_backup_changed(self):
        harness = Harness(api=FakeApi(is_backup=True, weight=7, is_drain=True, is_offline=True))
        self.scale_out(harness)
        self.assertEqual(harness.api.updates, [{"is_backup": False, "weight": 7, "is_drain": True, "is_offline": True}])

    def test_b_uses_the_values_read_just_before_acting(self):
        harness = Harness()
        harness.ticks(0.9, 3)
        harness.api.backends[SECOND].weight = 42
        harness.ticks(0.9, 4)
        self.assertEqual(harness.api.updates[0]["weight"], 42)

    def test_reads_backend_and_health_immediately_before_updating(self):
        harness = Harness()
        self.scale_out(harness)
        names = [call[0] for call in harness.api.addressed]
        index = names.index("update_backend")
        self.assertEqual(names[index - 2 : index], ["get_backend", "get_backend_health"])

    def test_c_no_call_when_the_flag_already_has_the_target(self):
        harness = Harness(api=FakeApi(is_backup=False))
        records = harness.ticks(0.9, 20)
        self.assertEqual(harness.api.updates, [])
        self.assertEqual(records[-1]["decision"], c.SCALE_OUT)
        self.assertEqual(records[-1]["api_result"], "noop")
        self.assertIsNone(harness.controller.last_change_at)
        self.assertEqual(len(harness.controller.samples), 19)

    def test_c_repeated_decision_reads_only_on_the_refresh_interval(self):
        harness = Harness(api=FakeApi(is_backup=False))
        harness.ticks(0.9, 13)
        reads = [call for call in harness.api.addressed if call[0] == "get_backend"]
        self.assertEqual(len(reads), 3)

    def test_d_work_request_timeout_is_a_failure(self):
        harness = Harness()
        harness.api.apply_update = False
        harness.api.work_request_status = "IN_PROGRESS"
        records = self.scale_out(harness)
        self.assertEqual(records[-1]["api_result"], "timeout")
        self.assertEqual(records[-1]["work_request_result"], "IN_PROGRESS")
        self.assertIn("not confirmed", records[-1]["error"])
        self.assertIs(harness.controller.flag, True)
        self.assertFalse(harness.controller.flag_confirmed)
        self.assertIsNone(harness.controller.last_change_at)
        self.assertEqual(len(harness.controller.samples), 6)
        self.assertEqual(harness.controller.api_failures, 1)

    def test_d_success_of_the_work_request_alone_is_not_enough(self):
        harness = Harness()
        harness.api.apply_update = False
        self.assertEqual(self.scale_out(harness)[-1]["api_result"], "timeout")

    def test_d_the_flag_alone_is_not_enough_while_the_work_request_runs(self):
        harness = Harness()
        harness.api.work_request_status = "IN_PROGRESS"
        self.assertEqual(self.scale_out(harness)[-1]["api_result"], "timeout")

    def test_failed_work_request_is_a_failure(self):
        harness = Harness()
        harness.api.work_request_status = "FAILED"
        record = self.scale_out(harness)[-1]
        self.assertEqual((record["api_result"], record["work_request_result"]), ("failed", "FAILED"))
        self.assertEqual(harness.controller.api_failures, 1)

    def test_a_poll_error_keeps_polling(self):
        harness = Harness()
        harness.api.work_request_errors = 2
        self.assertEqual(self.scale_out(harness)[-1]["api_result"], "updated")

    def test_missing_header_falls_back_to_reading_the_backend(self):
        harness = Harness()
        harness.api.work_request_header = False
        record = self.scale_out(harness)[-1]
        self.assertEqual((record["api_result"], record["work_request_result"]), ("updated", None))
        self.assertEqual(harness.api.work_request_ids, [])

    def test_stopping_during_the_poll_does_not_claim_success(self):
        harness = Harness()
        harness.api.work_request_status = "IN_PROGRESS"
        harness.actuator._wait = lambda seconds: True
        self.assertEqual(self.scale_out(harness)[-1]["api_result"], "interrupted")


class ControllerTests(unittest.TestCase):
    def test_scale_out_then_scale_in(self):
        harness = Harness()
        records = harness.ticks(0.9, 7)
        self.assertEqual(records[-1]["decision"], c.SCALE_OUT)
        self.assertEqual(records[-1]["api_result"], "updated")
        self.assertEqual(records[-1]["work_request_result"], "SUCCEEDED")
        self.assertIs(records[-1]["flag"], False)
        records = harness.ticks(0.1, 61)
        self.assertEqual([r["api_result"] for r in records if r["api_result"] == "updated"], ["updated"])
        self.assertIs(harness.api.backends[SECOND].is_backup, True)

    def test_windows_are_cleared_after_a_change(self):
        harness = Harness()
        harness.ticks(0.9, 7)
        self.assertEqual(len(harness.controller.samples), 0)
        self.assertEqual(harness.controller.last_change_at, harness.clock.now - 5)

    def test_next_scale_in_needs_a_full_window_after_the_change(self):
        harness = Harness()
        harness.ticks(0.9, 7)
        records = harness.ticks(0.1, 59)
        self.assertEqual(len(harness.api.updates), 1)
        self.assertFalse(records[-1]["scale_in_window_full"])
        self.assertEqual(harness.ticks(0.1, 1)[0]["decision"], c.SCALE_IN)
        self.assertEqual(len(harness.api.updates), 2)

    def test_next_change_waits_for_the_cooldown_with_a_full_window(self):
        harness = Harness(api=FakeApi(is_backup=False))
        harness.ticks(0.1, 61)
        self.assertEqual(len(harness.api.updates), 1)
        changed_at = harness.controller.last_change_at
        records = harness.ticks(0.9, 23)
        self.assertTrue(records[-1]["scale_out_window_full"])
        self.assertEqual(records[-1]["reason"], "cooldown")
        self.assertEqual(len(harness.api.updates), 1)
        harness.ticks(0.9, 1)
        self.assertEqual(len(harness.api.updates), 2)
        self.assertEqual(harness.controller.last_change_at - changed_at, 120)

    def test_flapping_input_changes_nothing(self):
        harness = Harness()
        for _ in range(200):
            harness.ticks(0.95, 1)
            harness.ticks(0.05, 1)
        self.assertEqual(harness.api.updates, [])

    def test_short_spikes_change_nothing(self):
        harness = Harness()
        for _ in range(30):
            harness.ticks(0.95, 4)
            harness.ticks(0.2, 4)
        self.assertEqual(harness.api.updates, [])

    def test_sustained_oscillation_is_rate_limited_by_windows_and_cooldown(self):
        harness = Harness(api=FakeApi(is_backup=True))
        for _ in range(20):
            harness.ticks(0.9, 10)
            harness.ticks(0.1, 10)
        self.assertLessEqual(len(harness.api.updates), 8)

    def test_restart_needs_a_full_window_again(self):
        harness = Harness()
        harness.ticks(0.9, 6)
        self.assertEqual(harness.api.updates, [])
        harness.controller = harness.new_controller()
        records = harness.ticks(0.9, 6)
        self.assertEqual(harness.api.updates, [])
        self.assertEqual(records[-1]["reason"], "partial_window")
        harness.ticks(0.9, 1)
        self.assertEqual(len(harness.api.updates), 1)

    def test_first_tick_reads_backend_for_the_log(self):
        harness = Harness()
        record = harness.ticks(0.5, 1)[0]
        self.assertEqual((record["cpu"], record["reason"], record["error"]), (None, "no_baseline", None))
        self.assertEqual((record["flag"], record["backend_health"], record["api_result"]), (True, "OK", "read"))

    def test_refreshes_every_30_seconds_for_the_log(self):
        harness = Harness()
        records = harness.ticks(0.5, 13)
        self.assertEqual([i for i, r in enumerate(records) if r["backend_health"]], [0, 6, 12])

    def test_dry_run_never_updates_and_keeps_its_windows(self):
        harness = Harness(mode="dry_run")
        records = harness.ticks(0.9, 20)
        self.assertEqual(harness.api.updates, [])
        self.assertEqual(records[-1]["decision"], c.SCALE_OUT)
        self.assertEqual(records[-1]["api_result"], "dry_run")
        self.assertIsNone(harness.controller.last_change_at)

    def test_once_changes_nothing_and_prints_flag_and_health(self):
        harness = Harness(mode="once")
        harness.stat.level = 0.9
        stop = threading.Event()
        stop.wait = harness.clock.wait
        self.assertEqual(c.run_once(harness.controller, stop), c.EXIT_OK)
        self.assertEqual(len(harness.records), 1)
        record = harness.records[0]
        self.assertEqual(record["mode"], "once")
        self.assertEqual(record["cpu"], 0.9)
        self.assertEqual((record["flag"], record["backend_health"]), (True, "OK"))
        self.assertEqual(record["decision"], c.NO_CHANGE)
        self.assertEqual(harness.api.updates, [])

    def test_once_exits_non_zero_when_the_api_fails(self):
        harness = Harness(mode="once")
        harness.api.read_error = OSError("no route")
        stop = threading.Event()
        stop.wait = harness.clock.wait
        self.assertEqual(c.run_once(harness.controller, stop), c.EXIT_ERROR)

    def test_metric_error_skips_the_tick_and_leaves_the_flag(self):
        harness = Harness()
        harness.ticks(0.9, 3)
        harness.stat.error = OSError("gone")
        record = harness.ticks(0.9, 1)[0]
        self.assertEqual((record["cpu"], record["decision"], record["reason"]), (None, c.NO_CHANGE, "metric_error"))
        self.assertEqual(record["error"], "OSError")
        harness.stat.error = None
        self.assertEqual(len(harness.controller.samples), 2)
        self.assertEqual(harness.api.updates, [])

    def test_metric_and_api_errors_in_one_tick_are_both_logged(self):
        harness = Harness()
        harness.ticks(0.5, 1)
        harness.stat.error = OSError("gone")
        harness.api.read_error = ValueError("bad")
        harness.clock.now += 30
        self.assertEqual(harness.ticks(0.5, 1)[0]["error"], "OSError; ValueError")

    def test_backwards_counter_rebaselines_and_recovers(self):
        harness = Harness()
        harness.ticks(0.5, 3)
        harness.stat.idle -= 500
        record = harness.ticks(0.5, 1)[0]
        self.assertIn("backwards", record["error"])
        self.assertEqual(harness.ticks(0.5, 1)[0]["cpu"], 0.5)

    def test_read_error_before_acting_leaves_the_flag_alone(self):
        harness = Harness()
        harness.api.read_error = OSError("no route")
        records = harness.ticks(0.9, 7)
        self.assertEqual(harness.api.updates, [])
        self.assertEqual(records[0]["api_result"], "error")
        self.assertIs(harness.api.backends[SECOND].is_backup, True)

    def test_update_error_is_ignored_for_the_tick(self):
        harness = Harness()
        harness.api.update_error = OSError("conflict")
        record = harness.ticks(0.9, 7)[-1]
        self.assertEqual((record["api_result"], record["error"]), ("error", "OSError"))
        self.assertIsNone(harness.controller.last_change_at)

    def test_backoff_doubles_and_is_capped(self):
        harness = Harness(backoff_base_seconds=5.0, backoff_max_seconds=20.0)
        harness.api.read_error = OSError("no route")
        attempts = []
        for index in range(30):
            record = harness.ticks(0.5, 1)[0]
            if record["api_result"] == "error":
                attempts.append(index)
        gaps = [(after - before) * 5 for before, after in zip(attempts, attempts[1:])]
        self.assertEqual(gaps[:4], [5, 10, 20, 20])

    def test_sampling_continues_during_backoff(self):
        harness = Harness()
        harness.api.read_error = OSError("no route")
        records = harness.ticks(0.5, 10)
        self.assertIn("backoff", [r["api_result"] for r in records])
        self.assertEqual(len(harness.controller.samples), 9)

    def test_recovery_resets_the_backoff(self):
        harness = Harness()
        harness.api.read_error = OSError("no route")
        harness.ticks(0.5, 3)
        harness.api.read_error = None
        harness.clock.now += 400
        harness.ticks(0.5, 1)
        self.assertEqual(harness.controller.api_failures, 0)

    def test_change_that_lands_after_a_timeout_counts_as_a_change(self):
        harness = Harness()
        harness.api.apply_update = False
        harness.api.work_request_status = "IN_PROGRESS"
        harness.ticks(0.9, 7)
        harness.api.backends[SECOND].is_backup = False
        harness.clock.now += 30
        record = harness.ticks(0.9, 1)[0]
        self.assertEqual((record["decision"], record["reason"]), (c.NO_CHANGE, "flag_changed"))
        self.assertIs(record["flag"], False)
        self.assertEqual(len(harness.controller.samples), 0)
        self.assertIsNotNone(harness.controller.last_change_at)

    def test_error_text_holds_no_api_message(self):
        class ServiceError(Exception):
            status = 404
            code = "NotAuthorizedOrNotFound"

        harness = Harness()
        harness.api.read_error = ServiceError("details about example-nlb")
        record = harness.ticks(0.5, 1)[0]
        self.assertEqual(record["error"], "ServiceError 404 NotAuthorizedOrNotFound")

    def test_log_line_keeps_its_field_names(self):
        harness = Harness()
        for record in harness.ticks(0.9, 8):
            self.assertEqual(tuple(record), c.LOG_FIELDS)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            c.emit_json(harness.records[-1])
        self.assertEqual(tuple(json.loads(output.getvalue())), c.LOG_FIELDS)

    def test_one_line_per_tick(self):
        harness = Harness()
        harness.ticks(0.9, 8)
        self.assertEqual(len(harness.records), 8)


class LifecycleTests(unittest.TestCase):
    def test_sigterm_stops_the_loop_and_leaves_the_flag(self):
        harness = Harness()
        stop = threading.Event()
        previous = signal.getsignal(signal.SIGTERM), signal.getsignal(signal.SIGINT)
        self.addCleanup(signal.signal, signal.SIGTERM, previous[0])
        self.addCleanup(signal.signal, signal.SIGINT, previous[1])
        c.install_signal_handlers(stop)
        real_tick = harness.controller.tick

        def tick_then_terminate():
            real_tick()
            os.kill(os.getpid(), signal.SIGTERM)

        harness.controller.tick = tick_then_terminate
        c.run(harness.controller, stop)
        self.assertTrue(stop.is_set())
        self.assertEqual(harness.api.updates, [])

    def test_loop_survives_an_unexpected_tick_error(self):
        harness = Harness()
        stop = threading.Event()
        calls = []

        def broken_tick():
            calls.append(1)
            if len(calls) == 2:
                stop.set()
            raise RuntimeError("unexpected")

        harness.controller.tick = broken_tick
        harness.controller.config = config(sample_seconds=0.001)
        with contextlib.redirect_stderr(io.StringIO()):
            c.run(harness.controller, stop)
        self.assertEqual(len(calls), 2)

    def test_sdk_is_not_imported_at_module_level(self):
        self.assertFalse(any(name == "oci" or name.startswith("oci.") for name in sys.modules))

    def test_missing_sdk_is_an_api_error_not_a_crash(self):
        def missing_sdk():
            raise ModuleNotFoundError("No module named 'oci'")

        harness = Harness()
        harness.actuator._api_factory = missing_sdk
        record = harness.ticks(0.5, 1)[0]
        self.assertEqual((record["api_result"], record["error"]), ("error", "ModuleNotFoundError"))


if __name__ == "__main__":
    unittest.main()
