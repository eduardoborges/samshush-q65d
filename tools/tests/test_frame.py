import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE))
spec = importlib.util.spec_from_file_location("frame", BASE / "frame.py")
frame = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = frame
spec.loader.exec_module(frame)


class HostTests(unittest.TestCase):
    def test_launchpad_widget_and_previous_widget_require_their_operations(self):
        for arguments in (
            ["launchpad", "install"],
            ["launchpad", "activate"],
            ["launchpad", "update"],
            ["launchpad", "update", "--widget", "new.wgt"],
            [
                "launchpad",
                "install",
                "--widget",
                "new.wgt",
                "--previous-widget",
                "old.wgt",
            ],
            ["launchpad", "restore", "--widget", "example.wgt"],
        ):
            with (
                self.subTest(arguments=arguments),
                patch.object(frame.sys, "argv", ["frame.py", *arguments]),
                patch.object(frame, "verify_files") as verify,
                patch("sys.stderr", new_callable=io.StringIO),
                self.assertRaises(SystemExit) as raised,
            ):
                frame.main()
            self.assertEqual(raised.exception.code, 2)
            verify.assert_not_called()

    def test_launchpad_dispatches_separately_from_stock_home_controls(self):
        for operation in (
            "inspect",
            "launch",
            "status",
            "restore",
            "install",
            "update",
            "activate",
            "archive",
        ):
            arguments = ["frame.py", "--tv", "192.0.2.1", "launchpad", operation]
            if operation in ("install", "update", "activate"):
                arguments += ["--widget", "Shortcuts.wgt"]
            if operation == "update":
                arguments += ["--previous-widget", "Previous.wgt"]
            with (
                self.subTest(operation=operation),
                patch.object(frame.sys, "argv", arguments),
                patch.object(frame, "verify_files"),
                patch("launchpad.run", return_value=0) as run,
            ):
                self.assertEqual(frame.main(), 0)
            self.assertEqual(run.call_args.args[0].operation, operation)

    def test_launchpad_runs_only_on_profiles_that_pin_it(self):
        base = ["frame.py", "--tv", "192.0.2.1", "launchpad", "status"]
        with (
            patch.object(frame.sys, "argv", base),
            patch.object(frame, "verify_files"),
            patch("launchpad.run", return_value=0) as run,
        ):
            self.assertEqual(frame.main(), 0)
        run.assert_called_once()
        unpinned = {k: v for k, v in frame.policy().items() if k != "launchpad"}
        with (
            patch.object(frame.sys, "argv", base),
            patch.object(frame, "policy", return_value=unpinned),
            patch.object(frame, "verify_files") as verify,
            patch("launchpad.run") as run,
            patch("sys.stderr", new_callable=io.StringIO),
            self.assertRaises(SystemExit) as raised,
        ):
            frame.main()
        self.assertEqual(raised.exception.code, 2)
        verify.assert_not_called()
        run.assert_not_called()

    def test_unvalidated_commands_and_scopes_stop_before_tv_access(self):
        for action in (
            ["home", "inspect"],
            ["quiet-hours", "status"],
            ["packages", "status"],
            ["certificates", "status"],
            ["auto-update", "status"],
            ["apply", "--scope", "services"],
            ["apply", "--scope", "certificates"],
        ):
            with (
                self.subTest(action=action),
                patch.object(
                    frame.sys, "argv", ["frame.py", "--tv", "192.0.2.1", *action]
                ),
                patch.object(frame, "verify_files") as verify,
                patch("sys.stderr", new_callable=io.StringIO),
                self.assertRaises(SystemExit) as raised,
            ):
                frame.main()
            self.assertEqual(raised.exception.code, 2)
            verify.assert_not_called()

    def test_voice_scope_excludes_unrelated_units(self):
        policy = frame.policy()
        encoded = frame.render("apply", "voice").split()[2]
        script = frame.base64.b64decode(encoded).decode()
        self.assertIn("\n".join(policy["voice_privacy"]["systemd_units"]), script)
        for entry in policy["optional_controls"].values():
            for unit in entry["systemd_units"]:
                self.assertNotIn(unit, script)
        self.assertIn("SCOPE='voice'", script)

    def test_optional_groups_have_independent_state_and_valid_shell(self):
        for group, entries in frame.policy()["optional_controls"].items():
            for action in ("apply", "status", "restore"):
                if entries["application_ids"]:
                    script = frame.render_apps(action, group=group)
                    self.assertIn(
                        f"STATE=/opt/usr/home/owner/share/frame-apps-{group}-v1", script
                    )
                    self.assertNotIn(
                        "STATE=/opt/usr/home/owner/share/frame-voice-apps-v2", script
                    )
                    subprocess.run(
                        ["/bin/bash", "-n"], input=script, text=True, check=True
                    )
                if entries["systemd_units"]:
                    script = frame.base64.b64decode(
                        frame.render(action, "services", unit_group=group).split()[2]
                    ).decode()
                    self.assertIn(f"STATE=/run/frame-services-{group}-v1", script)
                    self.assertIn("LOCK=/run/frame-runtime-v1.lock", script)
                    subprocess.run(
                        ["/bin/bash", "-n"], input=script, text=True, check=True
                    )

    def test_service_audit_is_complete_and_rejects_wrong_identity(self):
        script = frame.render_service_audit()
        subprocess.run(["/bin/bash", "-n"], input=script, text=True, check=True)
        self.assertNotIn("@@", script)
        self.assertIn("data-service.service", script)
        self.assertIn("com.samsung.tv.wifi-motion-mgr.service", script)
        self.assertIn("/usr/bin/dotnet-launcher-inhouse", script)
        result = subprocess.run(
            ["/bin/bash"],
            input="id() { printf 999; }\n" + script,
            text=True,
            capture_output=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("SERVICE AUDIT COMPLETE", result.stdout)

    def test_transport_preserves_script_literals(self):
        text = "printf '%s' 'spaces $HOME `false` ; \"quotes\"'"
        result = subprocess.run(
            ["/bin/bash", "-c", frame.wrapped(text)],
            capture_output=True,
            text=True,
            check=True,
        )
        self.assertEqual(result.stdout, 'spaces $HOME `false` ; "quotes"')

    def test_global_transport_executes_decoded_script(self):
        policy = {
            "build": "test",
            "units": [],
            "device_identity": {"architecture": "armv7l"},
        }
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            payload = "printf '%s' 'literal $HOME ; payload'\n"
            nsenter = root / "nsenter"
            nsenter.write_text(
                '#!/bin/bash\ntest "$1" = --mount=/proc/1/ns/mnt || exit 99\nshift\nexec "$@"\n'
            )
            nsenter.chmod(0o700)
            with (
                patch.object(frame.device_scripts, "RUNTIME", payload),
                patch.object(frame, "policy", return_value=policy),
            ):
                for action in ("status", "restore"):
                    with self.subTest(action=action):
                        result = subprocess.run(
                            [
                                "/bin/bash",
                                "-c",
                                frame.wrapped(frame.render(action, "none")),
                            ],
                            env=os.environ
                            | {"PATH": str(root) + ":" + os.environ["PATH"]},
                            capture_output=True,
                            text=True,
                            check=True,
                        )
                        self.assertEqual(result.stdout, "literal $HOME ; payload")

    def test_native_app_scripts_and_reboot_readback(self):
        for action in ("apply", "status", "verify", "restore"):
            with self.subTest(action=action):
                script = frame.render_apps(action)
                subprocess.run(["/bin/bash", "-n"], input=script, text=True, check=True)
                self.assertNotIn("@@", script)
                if action == "verify":
                    self.assertIn("/proc/sys/kernel/random/boot_id", script)
                    self.assertLess(
                        script.index("BOOT READBACK"),
                        script.index("LAUNCH DENIED"),
                    )
        subprocess.run(
            ["/bin/bash", "-n"],
            input=frame.device_scripts.STARTUP_GUARDS,
            text=True,
            check=True,
        )

    def app_functions(self, root):
        script = frame.render_apps("apply")
        start = script.index("flag() {")
        end = script.index("verify_flags() {")
        return script[start:end].replace("/proc/", str(root / "proc") + "/")

    def test_managed_process_requires_exact_dll_argument(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            proc = root / "proc" / "123"
            proc.mkdir(parents=True)
            expected = "/opt/usr/apps/voice/bin/Voice.dll"
            for executable, argument, accepted in (
                (expected, expected, True),
                ("/usr/bin/dotnet-loader", expected, True),
                ("/usr/bin/dotnet-launcher-inhouse", expected, True),
                ("/usr/bin/dotnet-loader", expected + ".other", False),
                ("/usr/bin/dotnet-loader", "/different/Voice.dll", False),
                ("/unrelated/program", expected, False),
            ):
                with self.subTest(executable=executable, argument=argument):
                    (proc / "exe").unlink(missing_ok=True)
                    (proc / "exe").symlink_to(executable)
                    (proc / "cmdline").write_bytes(argument.encode() + b"\0")
                    result = subprocess.run(
                        ["/bin/bash"],
                        input=self.app_functions(root)
                        + f"matches_process 123 {expected}\n",
                        text=True,
                        capture_output=True,
                    )
                    self.assertEqual(result.returncode == 0, accepted, result.stderr)

    def test_absence_check_finds_surviving_managed_apps(self):
        expected = "/opt/usr/apps/example/bin/Example.dll"
        for runtime, survives in (
            ("/usr/bin/dotnet-launcher-inhouse", True),
            ("/usr/bin/dotnet-loader", True),
            ("/unrelated/program", False),
        ):
            with self.subTest(runtime=runtime), tempfile.TemporaryDirectory() as d:
                root = Path(d)
                proc = root / "proc" / "123"
                proc.mkdir(parents=True)
                (proc / "exe").symlink_to(runtime)
                (proc / "cmdline").write_bytes(expected.encode() + b"\0")
                (root / "before.tsv").write_text(f"example\tfalse\t123\t{expected}\n")
                result = subprocess.run(
                    ["/bin/bash"],
                    input=f"STATE={root}\nstage={root}\n"
                    + self.app_functions(root)
                    + "verify_absent\n",
                    text=True,
                    capture_output=True,
                )
                self.assertEqual(result.returncode != 0, survives, result.stdout)
                self.assertEqual("SURVIVING MANAGED APP" in result.stdout, survives)

    def test_privacy_audit_has_valid_shell_and_requires_matching_build(self):
        script = frame.device_scripts.PRIVACY_AUDIT.replace(
            "@@BUILD@@", frame.policy()["build"]
        )
        subprocess.run(["/bin/bash", "-n"], input=script, text=True, check=True)
        # Identity failure must stop before any device query.
        result = subprocess.run(
            ["/bin/bash"],
            input="id() { printf 999; }\n" + script,
            text=True,
            capture_output=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("PRIVACY AUDIT COMPLETE", result.stdout)

    def test_hdmi_device_count_is_bounded_and_checked(self):
        script = frame.device_scripts.HDMI_AUDIT.replace("@@BUILD@@", "test")
        subprocess.run(["/bin/bash", "-n"], input=script, text=True, check=True)
        parser = script[
            script.index("values=()") : script.index("query GetActiveDeviceName")
        ]
        for reply, expected in (
            ("   int32 0\n   int32 2", 0),
            ("   int32 -1\n   int32 2", 1),
            ("   int32 0\n   int32 99", 1),
            ("unavailable", 1),
        ):
            with self.subTest(reply=reply):
                result = subprocess.run(
                    [
                        "/bin/bash",
                        "-c",
                        "set -eu; count_reply=$1\n" + parser,
                        "test",
                        reply,
                    ],
                    capture_output=True,
                    text=True,
                )
                self.assertEqual(result.returncode, expected, result.stderr)

    def test_sound_sensor_uses_separate_recovery_state(self):
        for action in ("apply", "status", "verify", "restore"):
            script = frame.render_apps(action, sound_sensor=True)
            subprocess.run(["/bin/bash", "-n"], input=script, text=True, check=True)
            self.assertIn(
                "STATE=/opt/usr/home/owner/share/frame-sound-sensor-v1", script
            )
            self.assertNotIn("frame-voice-apps-v2", script)
            self.assertIn("com.samsung.tv.ambient-sound", script)
            self.assertNotIn("com.samsung.tv.tvsensor-iot-service", script)
            self.assertNotIn("com.samsung.tv.alexa-client", script)
            self.assertNotIn("25 persistent", script)

    def test_failed_remote_command_is_not_success(self):
        good = dict(
            authenticated=True,
            uid=0,
            euid=0,
            gid=0,
            egid=0,
            system_files_unchanged=True,
            staging_cleaned=True,
            commands=[{"exit_code": 0, "timed_out": False}],
        )
        frame.check_result(good)
        for bad in (
            {"commands": []},
            {"uid": 901},
            {"staging_cleaned": False},
            {"commands": [{"exit_code": 1, "timed_out": False}]},
            {"commands": [{"exit_code": 0, "timed_out": True}]},
        ):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                frame.check_result(good | bad)

    def test_checksum_rejects_tampering_and_path_escape(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            (root / "file").write_text("original")
            expected = frame.hashlib.sha256(b"original").hexdigest()
            (root / "SHA256SUMS.json").write_text(json.dumps({"file": expected}))
            with patch.object(frame, "ASSETS", root):
                frame.verify_files()
                (root / "file").write_text("changed")
                with self.assertRaises(ValueError):
                    frame.verify_files()
                (root / "SHA256SUMS.json").write_text(
                    json.dumps({"../escape": expected})
                )
                with self.assertRaises(ValueError):
                    frame.verify_files()

    def test_doctor_rejects_unrunnable_sdb(self):
        from samsung_tv_root import sdb

        with (
            patch.object(frame.sys, "argv", ["frame.py", "doctor"]),
            patch.object(frame, "verify_files"),
            patch("sys.stdout", new_callable=io.StringIO),
            patch.object(sdb, "find_sdb", return_value=Path("/fake/sdb")),
            patch.object(frame.subprocess, "run", side_effect=OSError("bad CPU type")),
        ):
            self.assertEqual(frame.main(), 1)

    def test_global_operations_enter_namespace_and_inspection_does_not(self):
        self.assertTrue(
            frame.render("apply", "voice").endswith(
                "nsenter --mount=/proc/1/ns/mnt /bin/bash"
            )
        )
        self.assertTrue(frame.render("inspect", "none").startswith("# Generated"))
        for action, scope in (
            ("inspect", "none"),
            ("status", "none"),
            ("apply", "voice"),
            ("restore", "none"),
        ):
            subprocess.run(
                ["/bin/bash", "-n"],
                input=frame.render(action, scope),
                text=True,
                check=True,
            )


if __name__ == "__main__":
    unittest.main()
