import base64
import contextlib
import copy
import hashlib
import io
import json
import subprocess
import sys
import tempfile
import unittest
import warnings
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import frame  # noqa: E402
import launchpad  # noqa: E402
import launchpad_routing  # noqa: E402

Q65D_BUILD = "T-NKLDUABC-0090-REL-202603190159"
OTHER_BUILD = "T-OTHERBLD-0090-REL-202601010000"
Q65D_HASHES = {path: "d" * 64 for path in launchpad_routing.HASHES}


def access(origin):
    return f'<access origin="{origin}" subdomains="false"/>\n'.encode()


def privilege(name):
    return f'<tizen:privilege name="http://tizen.org/privilege/{name}"/>\n'.encode()


def manifest(origins, privileges=("application.launch", "tv.window", "internet")):
    return (
        b'<widget xmlns="http://www.w3.org/ns/widgets" '
        b'xmlns:tizen="http://tizen.org/ns/widgets" '
        b'id="https://example.invalid/shortcuts" version="0.4.0">\n'
        b'<tizen:application package="Gxqk7W2na5" id="Gxqk7W2na5.Shortcuts" '
        b'required_version="9.0"/>\n'
        b'<content src="index.html"/>\n<tizen:profile name="tv"/>\n'
        + b"".join(privilege(name) for name in privileges)
        + b"".join(access(origin) for origin in origins)
        + b"</widget>"
    )


ORIGINS = (
    launchpad.WEATHER_ORIGIN,
    launchpad.QUOTE_ORIGIN,
    launchpad.TETHER_ORIGIN,
    launchpad.MARINE_ORIGIN,
)
MANIFEST = manifest(ORIGINS)
PREVIOUS_PRIVILEGES = (
    "application.launch",
    "tv.window",
    "internet",
    "filesystem.read",
    "filesystem.write",
)
# The installed v25 shape: the Frame base files, every current module and weather-config.json.
PREVIOUS_MANIFEST = manifest(ORIGINS, PREVIOUS_PRIVILEGES)
DIGESTS = {
    "sha256": "http://www.w3.org/2001/04/xmlenc#sha256",
    "sha512": "http://www.w3.org/2001/04/xmlenc#sha512",
}


def current_resources():
    resources = {
        name: f"window.test = {name!r};".encode() for name in launchpad.RESOURCES
    }
    resources["config.xml"] = MANIFEST
    resources["icon.png"] = b"\x89PNG\r\n\x1a\nfixture"
    return resources


def previous_resources(modules=tuple(launchpad.MODULE_ORIGINS), origins=ORIGINS):
    resources = {
        name: f"previous {name}".encode()
        for name in launchpad.PREVIOUS_BASE + tuple(modules)
    }
    resources["config.xml"] = manifest(origins, PREVIOUS_PRIVILEGES)
    resources[launchpad.PREVIOUS_CONFIG] = b"{}\n"
    return resources


def signature(resources, algorithm):
    """A structural fixture with intentionally untrusted signature/cert bytes."""
    namespace = launchpad.DS_NS
    root = ET.Element(namespace + "Signature")
    info = ET.SubElement(root, namespace + "SignedInfo")
    for name, data in resources.items():
        reference = ET.SubElement(info, namespace + "Reference", URI=name)
        ET.SubElement(
            reference, namespace + "DigestMethod", Algorithm=DIGESTS[algorithm]
        )
        ET.SubElement(reference, namespace + "DigestValue").text = base64.b64encode(
            hashlib.new(algorithm, data).digest()
        ).decode()
    ET.SubElement(info, namespace + "Reference", URI="#properties")
    ET.SubElement(root, namespace + "SignatureValue").text = base64.b64encode(
        b"fixture only - not a cryptographic signature"
    ).decode()
    key = ET.SubElement(root, namespace + "KeyInfo")
    certificates = ET.SubElement(key, namespace + "X509Data")
    ET.SubElement(certificates, namespace + "X509Certificate").text = base64.b64encode(
        b"fixture only - not an X509 certificate"
    ).decode()
    return ET.tostring(root)


def signed_members(resources, algorithm="sha256"):
    members = dict(resources)
    members["author-signature.xml"] = signature(resources, algorithm)
    members["signature1.xml"] = signature(members, algorithm)
    return members


def write_widget(path, members, duplicate=None):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", UserWarning)
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
            for name, data in members.items():
                archive.writestr(name, data)
            if duplicate:
                archive.writestr(duplicate, members[duplicate])


class LaunchpadTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="samshush-widget-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / "launcher"
        self.source.mkdir()
        self.resources = current_resources()
        for name, data in self.resources.items():
            (self.source / name).write_bytes(data)
        self.widget = self.root / "Shortcuts.wgt"

    def verify(self, members=None, **kwargs):
        write_widget(self.widget, members or signed_members(self.resources), **kwargs)
        return launchpad.verify_widget(self.widget, self.source)

    def previous(self, resources):
        write_widget(self.widget, signed_members(resources))
        return launchpad.signed_widget_resources(self.widget, previous=True)

    def test_checked_in_launcher_is_the_complete_current_shape(self):
        files = launchpad.source_files()
        self.assertEqual(set(files), set(launchpad.RESOURCES))
        for retired in ("weather.js", "water-lilies.jpg", "time-controls.js"):
            self.assertFalse((launchpad.SOURCE / retired).exists())
        self.assertEqual(
            launchpad.manifest_identity(files["config.xml"], files).app,
            "Gxqk7W2na5.Shortcuts",
        )

    def test_current_widget_needs_every_module_and_no_previous_files(self):
        self.assertEqual(self.verify().app, "Gxqk7W2na5.Shortcuts")
        for extra in (
            "weather.js",
            "time-controls.js",
            "water-lilies.jpg",
            launchpad.PREVIOUS_CONFIG,
            "news.js",
        ):
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                self.verify(signed_members(self.resources | {extra: b"{}\n"}))
        for module in launchpad.MODULE_ORIGINS:
            missing = {k: v for k, v in self.resources.items() if k != module}
            with self.subTest(missing=module), self.assertRaises(ValueError):
                self.verify(signed_members(missing))

    def test_each_module_unlocks_only_its_own_origins(self):
        resources = dict.fromkeys(launchpad.RESOURCES)
        launchpad.manifest_identity(MANIFEST, resources)
        for origin in ORIGINS:
            with (
                self.subTest(missing=origin),
                self.assertRaisesRegex(ValueError, "network access"),
            ):
                launchpad.manifest_identity(
                    MANIFEST.replace(access(origin), b""), resources
                )
        for extra in (
            "https://example.com",
            launchpad.NEWS_ORIGIN,
            "https://g1.globo.com",
        ):
            with (
                self.subTest(extra=extra),
                self.assertRaisesRegex(ValueError, "network access"),
            ):
                launchpad.manifest_identity(manifest(ORIGINS + (extra,)), resources)
        without_quote = {k: v for k, v in resources.items() if k != "quote.js"}
        with self.assertRaisesRegex(ValueError, "network access"):
            launchpad.manifest_identity(MANIFEST, without_quote)
        duplicate = MANIFEST.replace(
            b"</widget>", access(launchpad.MARINE_ORIGIN) + b"</widget>"
        )
        with self.assertRaisesRegex(ValueError, "network access"):
            launchpad.manifest_identity(duplicate, resources)

    def test_current_widget_rejects_the_previous_privileges(self):
        resources = dict.fromkeys(launchpad.RESOURCES)
        with self.assertRaisesRegex(ValueError, "privileges"):
            launchpad.manifest_identity(PREVIOUS_MANIFEST, resources)
        launchpad.manifest_identity(PREVIOUS_MANIFEST, resources, previous=True)

    def test_previous_widget_accepts_the_installed_shapes(self):
        cases = (
            previous_resources(),
            previous_resources(modules=(), origins=(launchpad.WEATHER_ORIGIN,)),
            previous_resources(
                modules=("quote.js",),
                origins=(launchpad.WEATHER_ORIGIN, launchpad.QUOTE_ORIGIN),
            ),
            previous_resources(
                modules=tuple(launchpad.MODULE_ORIGINS) + ("news.js",),
                origins=ORIGINS + (launchpad.NEWS_ORIGIN, launchpad.NEWS_IMAGE_ORIGIN),
            ),
            previous_resources(
                modules=("quote.js", "news.js"),
                origins=(
                    launchpad.WEATHER_ORIGIN,
                    launchpad.QUOTE_ORIGIN,
                    launchpad.TETHER_ORIGIN,
                    "https://g1.globo.com",
                ),
            ),
        )
        for resources in cases:
            with self.subTest(names=sorted(resources)):
                identity, files = self.previous(resources)
                self.assertEqual(identity.app, "Gxqk7W2na5.Shortcuts")
                self.assertEqual(files, resources)
                with self.assertRaises(ValueError):
                    launchpad.verify_widget(self.widget, self.source)

    def test_previous_widget_rejects_other_shapes(self):
        base = previous_resources()
        for changed in (
            self.resources,
            {k: v for k, v in base.items() if k != "water-lilies.jpg"},
            {k: v for k, v in base.items() if k != launchpad.PREVIOUS_CONFIG},
            base | {"extra.js": b"unexpected"},
            base | {"config.xml": manifest(ORIGINS)},
            base | {"config.xml": manifest(ORIGINS[1:], PREVIOUS_PRIVILEGES)},
            base | {launchpad.PREVIOUS_CONFIG: b'{"latitude":91,"longitude":0}'},
            base | {launchpad.PREVIOUS_CONFIG: b"{};alert(1)"},
        ):
            with self.subTest(names=sorted(changed)), self.assertRaises(ValueError):
                self.previous(changed)

    def test_retired_origins_are_accepted_only_in_a_previous_widget(self):
        awesome_only = (launchpad.WEATHER_ORIGIN, launchpad.QUOTE_ORIGIN)
        resources = dict.fromkeys(launchpad.RESOURCES)
        with self.assertRaisesRegex(ValueError, "network access"):
            launchpad.manifest_identity(manifest(awesome_only), resources)
        previous = dict.fromkeys(launchpad.PREVIOUS_BASE + ("quote.js",))
        launchpad.manifest_identity(
            manifest(awesome_only, PREVIOUS_PRIVILEGES), previous, previous=True
        )
        mixed = manifest(
            ORIGINS + ("https://g1.globo.com", launchpad.NEWS_IMAGE_ORIGIN),
            PREVIOUS_PRIVILEGES,
        )
        with self.assertRaisesRegex(ValueError, "network access"):
            launchpad.manifest_identity(
                mixed,
                dict.fromkeys(launchpad.PREVIOUS_BASE + ("quote.js", "news.js")),
                previous=True,
            )

    def test_rejects_wrong_identity_profile_entry_and_privileges(self):
        for before, after in (
            (b'package="Gxqk7W2na5"', b'package="short"'),
            (b'id="Gxqk7W2na5.Shortcuts"', b'id="OtherPkg12.Shortcuts"'),
            (b'required_version="9.0"', b'required_version="8.0"'),
            (b'name="tv"', b'name="mobile"'),
            (b'src="index.html"', b'src="https://example.com/"'),
            (b"privilege/tv.window", b"privilege/internet"),
            (b"privilege/tv.window", b"privilege/application.launch"),
            (b"https://api.open-meteo.com", b"https://example.com"),
            (b'subdomains="false"', b'subdomains="true"'),
        ):
            with self.subTest(after=after), self.assertRaises(ValueError):
                launchpad.manifest_identity(MANIFEST.replace(before, after))

    def test_rejects_network_access_home_registration_and_ambiguous_manifest(self):
        for entry in (
            b'<access origin="*"/>',
            b"<tizen:allow-navigation>https://example.com</tizen:allow-navigation>",
            b"<tizen:app-control/>",
            b'<tizen:application package="OtherPkg12" id="OtherPkg12.Other" required_version="9.0"/>',
            b'<content src="other.html"/>',
            b'<tizen:profile name="mobile"/>',
            b'<tizen:privilege name="http://tizen.org/privilege/internet"/>',
            b'<tizen:privilege name="http://tizen.org/privilege/filesystem.read"/>',
        ):
            with self.subTest(entry=entry), self.assertRaises(ValueError):
                launchpad.manifest_identity(
                    MANIFEST.replace(b"</widget>", entry + b"</widget>")
                )

    def test_rejects_altered_missing_extra_duplicate_and_foreign_resources(self):
        changes = [
            {"ui.js": b"altered code"},
            {"config.xml": MANIFEST.replace(b"Gxqk7W2na5", b"OtherPkg12")},
            {"extra.js": b"unexpected"},
            {"../escape.js": b"unexpected"},
        ]
        for change in changes:
            with self.subTest(change=list(change)), self.assertRaises(ValueError):
                self.verify(signed_members(self.resources | change))
        for missing in ("icon.png", "author-signature.xml", "signature1.xml"):
            members = signed_members(self.resources)
            del members[missing]
            with self.subTest(missing=missing), self.assertRaises(ValueError):
                self.verify(members)
        with self.assertRaisesRegex(ValueError, "duplicate"):
            self.verify(duplicate="ui.js")

    def test_rejects_resource_symlinks_and_oversized_source(self):
        resource = self.source / "ui.js"
        resource.unlink()
        resource.symlink_to(self.source / "device.js")
        with self.assertRaisesRegex(ValueError, "resource"):
            launchpad.source_files(self.source)
        resource.unlink()
        resource.write_bytes(b"x" * (1024 * 1024 + 1))
        with self.assertRaisesRegex(ValueError, "resource"):
            launchpad.source_files(self.source)

    def test_command_requires_exactly_one_sdk_or_cli(self):
        common = ["launchpad.py", "--profile", "Samshush", "--output", "build"]
        with patch.object(launchpad, "build") as build:
            for options in (
                [],
                ["--sdk", "sdk", "--cli", "wrapper"],
                ["--sdk", "sdk", "--layout", "q65d-2123"],
                ["--sdk", "sdk", "--weather-postcode", "90210"],
            ):
                with (
                    self.subTest(options=options),
                    patch.object(sys, "argv", common + options),
                    contextlib.redirect_stderr(io.StringIO()),
                    self.assertRaises(SystemExit) as result,
                ):
                    launchpad.main()
                self.assertEqual(result.exception.code, 2)
            build.assert_not_called()
            for option in ("--sdk", "--cli"):
                with (
                    self.subTest(option=option),
                    patch.object(sys, "argv", common + [option, "tool"]),
                    contextlib.redirect_stdout(io.StringIO()),
                ):
                    launchpad.main()
                path = Path("tool").resolve()
                build.assert_called_with(
                    path if option == "--sdk" else None,
                    "Samshush",
                    Path("build").resolve(),
                    cli=path if option == "--cli" else None,
                )

    def test_exact_resources_and_sdk_sha512_digests_are_structurally_valid(self):
        for algorithm in DIGESTS:
            with self.subTest(algorithm=algorithm):
                identity = self.verify(signed_members(self.resources, algorithm))
                self.assertEqual(identity.app, "Gxqk7W2na5.Shortcuts")
                self.assertEqual(identity.package, "Gxqk7W2na5")
        # The deliberately fake signature/certificate above establishes only
        # structure and resource digests, never Samsung certificate trust.

    def test_sdk_wrapped_sha512_digests_allow_only_xml_whitespace(self):
        members = signed_members(self.resources, "sha512")
        root = ET.fromstring(members["signature1.xml"])
        values = root.findall(".//" + launchpad.DS_NS + "DigestValue")
        for value in values:
            digest = value.text
            value.text = " \t" + digest[:76] + "\r\n" + digest[76:] + "\n"
        members["signature1.xml"] = ET.tostring(root)
        self.assertEqual(self.verify(members).app, "Gxqk7W2na5.Shortcuts")
        original = values[0].text
        for invalid in ("!", "\N{NO-BREAK SPACE}"):
            values[0].text = original + invalid
            members["signature1.xml"] = ET.tostring(root)
            with (
                self.subTest(invalid=invalid),
                self.assertRaisesRegex(ValueError, "digest mismatch"),
            ):
                self.verify(members)

    def test_rejects_incomplete_signatures_digests_and_resource_coverage(self):
        namespace = launchpad.DS_NS
        mutations = (
            lambda root: root.remove(root.find(namespace + "SignatureValue")),
            lambda root: root.remove(root.find(namespace + "KeyInfo")),
            lambda root: root.find(".//" + namespace + "DigestValue").__setattr__(
                "text", "wrong"
            ),
            lambda root: root.find(".//" + namespace + "DigestMethod").set(
                "Algorithm", "unsupported"
            ),
            lambda root: root.find(namespace + "SignedInfo").remove(
                root.find(namespace + "SignedInfo/" + namespace + "Reference")
            ),
            lambda root: root.find(".//" + namespace + "Reference").set(
                "URI", "missing.js"
            ),
        )
        for index, mutate in enumerate(mutations):
            members = signed_members(self.resources)
            root = ET.fromstring(members["signature1.xml"])
            mutate(root)
            members["signature1.xml"] = ET.tostring(root)
            with self.subTest(index=index), self.assertRaises(ValueError):
                self.verify(members)
        members = signed_members(self.resources)
        members["signature1.xml"] = b"<Signature/>"
        with self.assertRaisesRegex(ValueError, "XML signature"):
            self.verify(members)

    def test_rejects_oversized_archive_members_and_unsafe_xml(self):
        self.widget.write_bytes(b"x" * (8 * 1024 * 1024 + 1))
        with self.assertRaisesRegex(ValueError, "Invalid signed widget"):
            launchpad.verify_widget(self.widget, self.source)
        members = signed_members(self.resources)
        members["icon.png"] = b"x" * (1024 * 1024 + 1)
        with self.assertRaisesRegex(ValueError, "oversized"):
            self.verify(members)
        for data in (
            b"",
            b"broken",
            b"x" * (256 * 1024 + 1),
            b"<!DOCTYPE widget><widget/>",
        ):
            with self.subTest(length=len(data)), self.assertRaises(ValueError):
                launchpad.parse_xml(data)

    def sdk(self):
        sdk = self.root / "sdk"
        cli = sdk / "tools/ide/bin/tizen"
        cli.parent.mkdir(parents=True)
        cli.write_text("#!/bin/sh\nexit 99\n")
        cli.chmod(0o700)
        return sdk

    def sdk_result(self, command, **kwargs):
        self.assertEqual(command[1:5], ["package", "-t", "wgt", "-s"])
        self.assertEqual(command[5], "existing-profile")
        self.assertEqual(kwargs["stdin"], subprocess.DEVNULL)
        self.assertEqual(kwargs["stdout"], subprocess.DEVNULL)
        self.assertEqual(kwargs["stderr"], subprocess.DEVNULL)
        self.assertEqual(kwargs["timeout"], 90)
        with zipfile.ZipFile(command[-1]) as archive:
            unsigned = {name: archive.read(name) for name in archive.namelist()}
        self.assertEqual(unsigned, self.resources)
        target = Path(command[command.index("-o") + 1]) / "Shortcuts.wgt"
        write_widget(target, signed_members(unsigned, "sha512"))
        return subprocess.CompletedProcess(command, 0)

    def test_sdk_success_promotes_only_verified_artifact_and_private_receipt(self):
        output = self.root / "build"
        with patch.object(launchpad.subprocess, "run", side_effect=self.sdk_result):
            artifact = launchpad.build(
                self.sdk(), "existing-profile", output, self.source
            )
        self.assertEqual(artifact, output / "Shortcuts.wgt")
        self.assertEqual(
            {path.name for path in output.iterdir()}, {"Shortcuts.wgt", "build.json"}
        )
        self.assertEqual(artifact.stat().st_mode & 0o777, 0o600)
        self.assertEqual(output.stat().st_mode & 0o777, 0o700)
        receipt = json.loads((output / "build.json").read_text())
        self.assertFalse(receipt["installed"])
        self.assertEqual(
            receipt["sha256"], hashlib.sha256(artifact.read_bytes()).hexdigest()
        )
        self.assertEqual(
            receipt["source_sha256"],
            {
                name: hashlib.sha256(data).hexdigest()
                for name, data in self.resources.items()
                if name in launchpad.RESOURCES
            },
        )
        self.assertEqual((output / "build.json").stat().st_mode & 0o777, 0o600)
        self.assertNotIn("existing-profile", (output / "build.json").read_text())

    def test_executable_cli_override_preserves_argv_and_artifact_verification(self):
        cli = self.root / "local wrapper.py"
        cli.write_text("#!/usr/bin/env python3\nraise SystemExit(99)\n")
        cli.chmod(0o700)
        with patch.object(
            launchpad.subprocess, "run", side_effect=self.sdk_result
        ) as run:
            artifact = launchpad.build(
                None,
                "existing-profile",
                self.root / "wrapper-build",
                self.source,
                cli=cli,
            )
        self.assertEqual(run.call_args.args[0][0], str(cli))
        self.assertEqual(
            launchpad.verify_widget(artifact, self.source).app,
            "Gxqk7W2na5.Shortcuts",
        )

    def test_invalid_cli_stops_before_creating_output_or_running_signer(self):
        non_executable = self.root / "not-executable"
        non_executable.write_text("#!/bin/sh\nexit 0\n")
        non_executable.chmod(0o600)
        output = self.root / "unused"
        with patch.object(launchpad.subprocess, "run") as run:
            for cli in (self.root / "missing", self.source, non_executable, None):
                with self.subTest(cli=cli), self.assertRaises(ValueError):
                    launchpad.build(
                        None, "existing-profile", output, self.source, cli=cli
                    )
            run.assert_not_called()
        self.assertFalse(output.exists())

    def test_partial_sdk_failures_never_promote_artifacts_or_success_receipts(self):
        sdk = self.sdk()
        for failure in ("exit", "timeout", "invalid"):
            output = self.root / failure

            def partial(command, mode=failure, **kwargs):
                result = self.sdk_result(command, **kwargs)
                if mode == "exit":
                    return subprocess.CompletedProcess(command, 1)
                if mode == "timeout":
                    raise subprocess.TimeoutExpired(command, 90)
                target = Path(command[command.index("-o") + 1]) / "Shortcuts.wgt"
                target.write_bytes(b"partial widget")
                return result

            with (
                self.subTest(failure=failure),
                patch.object(launchpad.subprocess, "run", side_effect=partial),
                self.assertRaises(ValueError),
            ):
                launchpad.build(sdk, "existing-profile", output, self.source)
            self.assertEqual(list(output.iterdir()), [])

    def test_invalid_profile_or_existing_output_stops_before_sdk(self):
        sdk = self.sdk()
        with patch.object(launchpad.subprocess, "run") as run:
            for profile in ("", "x" * 129, "line\nbreak"):
                with self.subTest(profile=profile), self.assertRaises(ValueError):
                    launchpad.build(sdk, profile, self.root / "unused", self.source)
            output = self.root / "existing"
            output.mkdir()
            (output / "keep").write_text("preserved")
            with self.assertRaises(FileExistsError):
                launchpad.build(sdk, "existing-profile", output, self.source)
            self.assertEqual((output / "keep").read_text(), "preserved")
            run.assert_not_called()


class LaunchpadDeviceTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="samshush-device-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / "launcher"
        self.source.mkdir()
        self.resources = current_resources()
        for name, data in self.resources.items():
            (self.source / name).write_bytes(data)
        self.widget = self.root / "Shortcuts.wgt"
        write_widget(self.widget, signed_members(self.resources))
        self.original_widget = self.widget.read_bytes()
        self.previous_widget = self.root / "Previous.wgt"
        self.previous_resources = previous_resources()
        write_widget(self.previous_widget, signed_members(self.previous_resources))
        self.assets = self.root / "assets"
        (self.assets / "payloads").mkdir(parents=True)
        for suffix in (".dll", ".runtimeconfig.json"):
            (self.assets / "payloads" / (launchpad_routing.NAME + suffix)).write_bytes(
                b"helper fixture"
            )
        self.route_build = Q65D_BUILD
        self.routing_calls = []
        self.routing_targets = []
        self.verified_models = []
        self.device_scripts = []
        self.sdk_calls = []
        self.pushes = []
        self.registration_count = "0"
        self.fail_resources = False
        self.fail_upload = False
        self.sdk_output = "install completed"
        self.sdk_returncode = 0
        self.model_error = None
        self.on_model = None
        self.on_sdk = None
        self.initial_phase = "absent"
        self.route_package = "Gxqk7W2na5"
        self.route_app = "Gxqk7W2na5.Shortcuts"
        self.route_autostart = 0
        self.bad_probe = False
        self.bad_routing = False
        self.journal_raw = None
        self.fake_frame = SimpleNamespace(
            ASSETS=self.assets,
            check_result=frame.check_result,
        )
        self.use_q65d()

    def route_output(self, operation):
        original = {
            "Operation": "com.samsung.tv.csfs",
            "Strings": {key: "" for key in launchpad_routing.KEYS},
            "AutoStart": self.route_autostart,
        }
        original["Strings"][launchpad_routing.HOME_KEY] = "com.samsung.tv.csfs"
        phase = {"apply": "applied", "restore": "restored"}.get(
            operation, self.initial_phase
        )
        current = copy.deepcopy(original)
        if phase in {"applied", "restore-failed"}:
            current["Operation"] = self.route_app
            current["Strings"][launchpad_routing.HOME_KEY] = current["Operation"]
        receipt = (
            None
            if phase == "absent"
            else {
                "Version": 1,
                "Build": self.route_build,
                "Package": self.route_package,
                "App": self.route_app,
                "Phase": phase,
                "Original": original,
            }
        )
        value = {
            "schema": "samshush-home-routing-v1",
            "operation": operation,
            "phase": phase,
            "current": current,
            "receipt": receipt,
        }
        return (
            "LAUNCHPAD_ROUTING_JSON="
            + json.dumps(value)
            + "\nLAUNCHPAD_ROUTING_CLEANED\n"
        )

    def run_operation(self, operation, *, widget=None):
        args = SimpleNamespace(
            operation=operation,
            tv="192.0.2.1",
            callback_host="192.0.2.2",
            widget=widget
            if widget is not None
            else self.widget
            if operation in {"install", "update", "activate"}
            else None,
            previous_widget=self.previous_widget if operation == "update" else None,
            logs=self.root / "reports",
        )
        source_files = launchpad.source_files
        verify_widget = launchpad.verify_widget

        def render(operation, artifacts, *, build, hashes, **options):
            self.routing_calls.append((operation, options))
            self.routing_targets.append((build, hashes, artifacts))
            return f"TEST_ROUTING {operation}\n"

        async def probe(*args, **kwargs):
            script = kwargs["commands"][0]
            self.device_scripts.append(script)
            rc = 0
            if "TEST_ROUTING " in script:
                requested = script.split("TEST_ROUTING ")[1].split()[0]
                if "LAUNCHPAD_RESOURCES_VERIFIED" in script:
                    rc = int(self.fail_resources)
                output = (
                    "missing routing output"
                    if self.bad_routing
                    else self.route_output(requested)
                )
                if requested in {"apply", "restore"}:
                    self.initial_phase = {"apply": "applied", "restore": "restored"}[
                        requested
                    ]
            elif "LAUNCHPAD_RESOURCES_VERIFIED" in script:
                rc = int(self.fail_resources)
                output = "LAUNCHPAD_PACKAGE_COUNT 1\nLAUNCHPAD_APP_COUNT 1\nLAUNCHPAD_RESOURCES_VERIFIED\n"
            elif "LAUNCHPAD_PACKAGE_COUNT" in script:
                output = f"LAUNCHPAD_PACKAGE_COUNT {self.registration_count}\nLAUNCHPAD_APP_COUNT {self.registration_count}\n"
            elif "LAUNCHPAD_JOURNAL_ARCHIVED" in script:
                output = "LAUNCHPAD_JOURNAL_ARCHIVED /opt/usr/share/samshush-home-v1.archived-fixture\n"
                self.initial_phase = "absent"
            elif "LAUNCHPAD_JOURNAL_RAW" in script:
                raw = self.journal_raw
                if raw is None:
                    status = self.route_output("status").split("\n")[0]
                    receipt = json.loads(status.removeprefix("LAUNCHPAD_ROUTING_JSON="))
                    raw = json.dumps(receipt["receipt"]).encode()
                output = (
                    f"LAUNCHPAD_JOURNAL_SHA256 {hashlib.sha256(raw).hexdigest()}\n"
                    f"LAUNCHPAD_JOURNAL_RAW {base64.b64encode(raw).decode()}\n"
                )
            elif "LAUNCHPAD_UPLOAD_CLEANED" in script:
                output = "LAUNCHPAD_UPLOAD_CLEANED\n"
            elif "LAUNCHPAD_UPLOAD_VERIFIED" in script:
                rc = int(self.fail_upload)
                output = "LAUNCHPAD_UPLOAD_VERIFIED\n"
            else:
                raise AssertionError("Unexpected device script")
            return {
                "authenticated": True,
                "uid": 0,
                "euid": 0,
                "gid": 0,
                "egid": 0,
                "system_files_unchanged": True,
                "staging_cleaned": not self.bad_probe,
                "commands": [{"stdout": output, "stderr": "", "exit_code": rc}],
            }

        def verify_model(tv, model):
            self.verified_models.append(model)
            if self.on_model:
                self.on_model()
            if self.model_error:
                raise self.model_error

        def push(local, remote):
            self.pushes.append((Path(local).read_bytes(), str(remote)))

        def sdk_run(command, **kwargs):
            self.sdk_calls.append(command)
            if self.on_sdk:
                self.on_sdk()
            return subprocess.CompletedProcess(
                command, self.sdk_returncode, self.sdk_output, ""
            )

        client = SimpleNamespace(
            serial="192.0.2.1:26101",
            connect=lambda: None,
            require_device=lambda: None,
            push=push,
            run=sdk_run,
        )
        with contextlib.ExitStack() as stack:
            for target, value in (
                ("launchpad.SOURCE", self.source),
                (
                    "launchpad.source_files",
                    lambda source=self.source: source_files(source),
                ),
                (
                    "launchpad.verify_widget",
                    lambda path: verify_widget(path, self.source),
                ),
                ("launchpad.verify_model", verify_model),
                ("launchpad.device_command", lambda script: script),
                ("launchpad_routing.render_script", render),
                ("samsung_tv_root.archive_root.probe", probe),
                ("samsung_tv_root.sdb.find_sdb", lambda: "fixture-sdb"),
                ("samsung_tv_root.sdb.SdbClient", lambda *args, **kwargs: client),
            ):
                stack.enter_context(patch(target, value))
            stack.enter_context(patch("builtins.print"))
            result = launchpad.run(args, self.fake_frame)
        reports = list(args.logs.glob("*.json"))
        self.assertEqual(len(reports), 1)
        self.assertEqual(reports[0].stat().st_mode & 0o777, 0o600)
        return result, json.loads(reports[0].read_text())

    def use_q65d(self, *, helper_build=Q65D_BUILD):
        helper = self.assets / "payloads" / "q65d-2123"
        helper.mkdir(exist_ok=True)
        (helper / (launchpad_routing.NAME + ".dll")).write_bytes(
            b"q65d helper " + helper_build.encode("utf-16-le")
        )
        (helper / (launchpad_routing.NAME + ".runtimeconfig.json")).write_bytes(b"{}")
        self.route_build = Q65D_BUILD
        policy = {
            "model": "QN55Q65DAGXZD",
            "build": Q65D_BUILD,
            "launchpad": {
                "helper": "payloads/q65d-2123",
                "routing_hashes": Q65D_HASHES,
                "verification": "fixture",
            },
        }
        self.fake_frame.policy = lambda: policy
        return policy

    def test_archive_saves_and_moves_only_a_verified_restored_journal(self):
        self.initial_phase = "restored"
        result, evidence = self.run_operation("archive")
        self.assertEqual(result, 0, evidence)
        self.assertEqual(self.routing_calls, [("status", {}), ("query", {})])
        read, archive = self.device_scripts[1:3]
        self.assertIn("LAUNCHPAD_JOURNAL_RAW", read)
        self.assertNotIn("mv --", read)
        saved = evidence["archived_journal"]
        raw = base64.b64decode(saved["raw"])
        self.assertEqual(json.loads(raw)["Phase"], "restored")
        self.assertIn(f"[[ $digest == {saved['sha256']} ]]", archive)
        self.assertEqual(hashlib.sha256(raw).hexdigest(), saved["sha256"])
        self.assertTrue(
            saved["path"].startswith(launchpad_routing.JOURNAL + ".archived-")
        )
        self.assertEqual(evidence["after"]["phase"], "absent")
        self.assertEqual(self.sdk_calls, [])

    def test_archive_refuses_an_active_or_missing_journal(self):
        for phase in ("applied", "absent"):
            with self.subTest(phase=phase):
                self.setUp()
                self.initial_phase = phase
                result, evidence = self.run_operation("archive")
                self.assertEqual(result, 1)
                self.assertFalse(
                    any("LAUNCHPAD_JOURNAL" in script for script in self.device_scripts)
                )

    def test_archive_stops_when_the_saved_journal_differs(self):
        self.initial_phase = "restored"
        self.journal_raw = b'{"Phase":"restored"}'
        result, evidence = self.run_operation("archive")
        self.assertEqual(result, 1)
        self.assertIn("differs", evidence["error"])
        self.assertFalse(any("mv --" in script for script in self.device_scripts))

    def test_install_uses_the_profile_build_helper_and_model(self):
        result, evidence = self.run_operation("install")
        self.assertEqual(result, 0, evidence)
        self.assertEqual(self.verified_models, ["QN55Q65DAGXZD"])
        self.assertTrue(self.routing_targets)
        for build, hashes, artifacts in self.routing_targets:
            self.assertEqual(build, Q65D_BUILD)
            self.assertEqual(hashes, Q65D_HASHES)
            self.assertTrue(artifacts[".dll"].startswith(b"q65d helper "))
        build_checks = [s for s in self.device_scripts if "BUILD_ID=" in s]
        self.assertTrue(build_checks)
        for script in build_checks:
            self.assertIn(f"BUILD_ID={Q65D_BUILD}", script)
            self.assertNotIn(OTHER_BUILD, script)

    def test_widget_must_match_the_checked_out_launcher(self):
        self.resources["index.html"] = b"<!doctype html><title>Other</title>"
        write_widget(self.widget, signed_members(self.resources))
        with self.assertRaises(ValueError):
            self.run_operation("install")
        self.assertEqual(self.device_scripts, [])

    def test_q65d_status_accepts_its_own_receipt(self):
        self.initial_phase = "applied"
        result, evidence = self.run_operation("status")
        self.assertEqual(result, 0, evidence)

    def test_q65d_status_rejects_a_receipt_from_another_build(self):
        self.initial_phase = "applied"
        self.route_build = OTHER_BUILD
        result, evidence = self.run_operation("status")
        self.assertEqual(result, 1)
        self.assertIn("Invalid", evidence["error"])

    def test_q65d_refuses_a_helper_built_for_another_firmware(self):
        self.use_q65d(helper_build=OTHER_BUILD)
        with self.assertRaisesRegex(ValueError, "another firmware"):
            self.run_operation("inspect")
        self.assertEqual(self.device_scripts, [])

    def test_inspect_uses_read_only_routing_and_no_sdk(self):
        result, evidence = self.run_operation("inspect")
        self.assertEqual(result, 0, evidence)
        self.assertEqual(self.routing_calls, [("query", {})])
        self.assertEqual(self.sdk_calls, [])
        self.assertEqual(self.pushes, [])

    def test_status_reads_journal_without_sdk_or_installation(self):
        self.initial_phase = "applied"
        result, evidence = self.run_operation("status")
        self.assertEqual(result, 0, evidence)
        self.assertEqual(self.routing_calls, [("status", {})])
        self.assertEqual(self.sdk_calls, [])
        self.assertEqual(self.pushes, [])

    def test_install_keeps_home_assignment_and_checks_resources_and_upload_cleanup(
        self,
    ):
        result, evidence = self.run_operation("install")
        self.assertEqual(result, 0, evidence)
        self.assertTrue(evidence["completed"])
        self.assertEqual(self.routing_calls, [("query", {})])
        self.assertEqual(self.pushes[0][0], self.original_widget)
        frozen = Path(evidence["verified_widget"])
        self.assertEqual(frozen.read_bytes(), self.original_widget)
        self.assertEqual(frozen.stat().st_mode & 0o777, 0o600)
        uploaded_hash = hashlib.sha256(self.original_widget).hexdigest()
        verification = next(
            script
            for script in self.device_scripts
            if "LAUNCHPAD_UPLOAD_VERIFIED" in script
        )
        self.assertIn(uploaded_hash, verification)
        self.assertEqual(self.sdk_calls[0][3:5], ("0", "vd_appinstall"))
        self.assertEqual(self.sdk_calls[0][5], "Gxqk7W2na5.Shortcuts")
        self.assertTrue(
            any(
                "LAUNCHPAD_RESOURCES_VERIFIED" in script
                for script in self.device_scripts
            )
        )
        self.assertIn("LAUNCHPAD_UPLOAD_CLEANED", self.device_scripts[-1])

    def test_update_verifies_previous_and_new_resources_and_preserves_home(self):
        self.initial_phase = "applied"
        new_widget = self.widget.read_bytes()
        old_widget = self.previous_widget.read_bytes()
        result, evidence = self.run_operation("update")
        self.assertEqual(result, 0, evidence)
        self.assertEqual([call[0] for call in self.routing_calls], ["status", "status"])
        self.assertEqual(evidence["before"]["receipt"], evidence["after"]["receipt"])
        self.assertEqual(evidence["before"]["current"], evidence["after"]["current"])
        self.assertEqual(self.pushes[0][0], new_widget)
        self.assertEqual(Path(evidence["previous_widget"]).read_bytes(), old_widget)
        self.assertEqual(
            Path(evidence["previous_widget"]).stat().st_mode & 0o777, 0o600
        )
        resource_checks = [
            script
            for script in self.device_scripts
            if "LAUNCHPAD_RESOURCES_VERIFIED" in script
        ]
        self.assertEqual(len(resource_checks), 2)
        # The previous widget is checked with its Frame-era files and weather setting.
        for name in ("ui.js", "water-lilies.jpg", launchpad.PREVIOUS_CONFIG):
            self.assertIn(
                hashlib.sha256(self.previous_resources[name]).hexdigest(),
                resource_checks[0],
            )
        for data in self.resources.values():
            self.assertIn(hashlib.sha256(data).hexdigest(), resource_checks[1])
        self.assertNotIn("water-lilies.jpg", resource_checks[1])
        self.assertNotIn(launchpad.PREVIOUS_CONFIG, resource_checks[1])
        self.assertEqual(len(self.sdk_calls), 1)
        self.assertEqual(
            self.sdk_calls[0][4:6], ("vd_appinstall", "Gxqk7W2na5.Shortcuts")
        )

    def test_update_accepts_a_previous_widget_with_the_retired_news_origin(self):
        self.initial_phase = "applied"
        self.previous_resources = previous_resources(
            modules=("quote.js", "news.js"),
            origins=(
                launchpad.WEATHER_ORIGIN,
                launchpad.QUOTE_ORIGIN,
                launchpad.TETHER_ORIGIN,
                "https://g1.globo.com",
            ),
        )
        self.previous_resources["news.js"] = b"previous news feed"
        write_widget(self.previous_widget, signed_members(self.previous_resources))
        result, evidence = self.run_operation("update")
        self.assertEqual(result, 0, evidence)
        resource_checks = [
            script
            for script in self.device_scripts
            if "LAUNCHPAD_RESOURCES_VERIFIED" in script
        ]
        self.assertIn(
            hashlib.sha256(b"previous news feed").hexdigest(), resource_checks[0]
        )

    def test_update_requires_an_applied_matching_home_journal_before_upload(self):
        for phase, package, app in (
            ("absent", "Gxqk7W2na5", "Gxqk7W2na5.Shortcuts"),
            ("restored", "Gxqk7W2na5", "Gxqk7W2na5.Shortcuts"),
            ("applied", "OtherPkg12", "OtherPkg12.Shortcuts"),
        ):
            with self.subTest(phase=phase, app=app):
                self.initial_phase, self.route_package, self.route_app = (
                    phase,
                    package,
                    app,
                )
                result, evidence = self.run_operation("update")
                self.assertEqual(result, 1)
                self.assertIn("matching applied Home assignment", evidence["error"])
                self.assertEqual(self.pushes, [])
                self.assertEqual(self.sdk_calls, [])
                for report in (self.root / "reports").glob("*.json"):
                    report.unlink()

    def test_previous_installed_resource_drift_blocks_update_before_upload(self):
        self.initial_phase = "applied"
        self.fail_resources = True
        result, evidence = self.run_operation("update")
        self.assertEqual(result, 1, evidence)
        self.assertEqual(self.pushes, [])
        self.assertEqual(self.sdk_calls, [])
        self.assertEqual([call[0] for call in self.routing_calls], ["status"])

    def test_update_failure_keeps_both_widgets_and_does_not_retry_or_change_home(self):
        self.initial_phase = "applied"
        self.sdk_output = "install failed"
        result, evidence = self.run_operation("update")
        self.assertEqual(result, 1, evidence)
        self.assertTrue(Path(evidence["previous_widget"]).is_file())
        self.assertTrue(Path(evidence["verified_widget"]).is_file())
        self.assertEqual(len(self.sdk_calls), 1)
        self.assertEqual([call[0] for call in self.routing_calls], ["status"])

    def test_update_fails_if_final_resources_or_home_receipt_change(self):
        for failure in ("resources", "home"):
            with self.subTest(failure=failure):
                self.initial_phase = "applied"
                self.fail_resources = False
                self.route_autostart = 0
                self.on_sdk = lambda failure=failure: setattr(
                    self,
                    "fail_resources" if failure == "resources" else "route_autostart",
                    1,
                )
                result, evidence = self.run_operation("update")
                self.assertEqual(result, 1, evidence)
                self.assertFalse(evidence["completed"])
                self.assertTrue(all(call[0] == "status" for call in self.routing_calls))
                if failure == "home":
                    self.assertIn("Home assignment changed", evidence["error"])
                for report in (self.root / "reports").glob("*.json"):
                    report.unlink()

    def test_invalid_previous_widget_stops_before_any_device_access(self):
        self.initial_phase = "applied"
        self.previous_widget.write_bytes(b"damaged recovery artifact")
        with self.assertRaises(ValueError):
            self.run_operation("update")
        self.assertEqual(self.device_scripts, [])
        self.assertEqual(self.sdk_calls, [])

    def test_changed_widget_during_preflight_never_installs_unverified_bytes(self):
        self.on_model = lambda: self.widget.write_bytes(b"changed after verification")
        result, evidence = self.run_operation("install")
        if self.sdk_calls:
            self.assertEqual(self.pushes[0][0], self.original_widget)
        else:
            self.assertEqual(result, 1, evidence)
            self.assertFalse(evidence["completed"])

    def test_existing_registration_blocks_install_before_push(self):
        self.registration_count = "1"
        result, evidence = self.run_operation("install")
        self.assertEqual(result, 1)
        self.assertIn("already registered", evidence["error"])
        self.assertEqual(self.pushes, [])
        self.assertEqual(self.sdk_calls, [])

    def test_wrong_model_stops_before_any_transport(self):
        self.model_error = ValueError("Wrong model")
        result, evidence = self.run_operation("install")
        self.assertEqual(result, 1)
        self.assertFalse(evidence["completed"])
        self.assertEqual(self.device_scripts, [])
        self.assertEqual(self.sdk_calls, [])

    def test_incomplete_installer_confirmation_keeps_failure_receipt(self):
        self.sdk_output = "installation requested"
        result, evidence = self.run_operation("install")
        self.assertEqual(result, 1)
        self.assertFalse(evidence["completed"])
        self.assertIn("not confirmed", evidence["error"])
        self.assertIn("staged_widget", evidence)
        self.assertEqual(len(self.sdk_calls), 1)

    def test_uploaded_widget_hash_failure_prevents_installer(self):
        self.fail_upload = True
        result, evidence = self.run_operation("install")
        self.assertEqual(result, 1)
        self.assertFalse(evidence["completed"])
        self.assertEqual(len(self.pushes), 1)
        self.assertEqual(self.sdk_calls, [])

    def test_sdk_failure_overrides_success_shaped_output(self):
        self.sdk_returncode = 1
        result, evidence = self.run_operation("install")
        self.assertEqual(result, 1)
        self.assertFalse(evidence["completed"])
        self.assertIn("SDK operation failed", evidence["error"])

    def test_invalid_local_widget_stops_before_device_access(self):
        self.widget.write_bytes(b"unsigned or damaged")
        with self.assertRaises(ValueError):
            self.run_operation("install")
        self.assertEqual(self.device_scripts, [])
        self.assertEqual(self.sdk_calls, [])
        self.assertEqual(self.pushes, [])

    def test_unverified_installed_resource_path_fails_before_launch(self):
        self.fail_resources = True
        self.sdk_output = "successfully launched"
        result, evidence = self.run_operation("launch")
        self.assertEqual(result, 1)
        self.assertFalse(evidence["completed"])
        self.assertEqual(self.sdk_calls, [])

    def test_launch_requires_resource_readback_and_sdk_confirmation(self):
        self.sdk_output = "successfully launched"
        result, evidence = self.run_operation("launch")
        self.assertEqual(result, 0, evidence)
        self.assertEqual(self.routing_calls, [("query", {})])
        self.assertEqual(
            self.sdk_calls[0],
            ("-s", "192.0.2.1:26101", "shell", "0", "execute", "Gxqk7W2na5.Shortcuts"),
        )
        self.assertIn("LAUNCHPAD_RESOURCES_VERIFIED", self.device_scripts[-1])
        self.assertEqual(self.pushes, [])

    def test_activate_checks_installed_resources_before_home_apply_and_status(self):
        result, evidence = self.run_operation("activate")
        self.assertEqual(result, 0, evidence)
        self.assertEqual(
            [call[0] for call in self.routing_calls], ["status", "apply", "status"]
        )
        self.assertEqual(
            self.routing_calls[1][1],
            {"package_id": "Gxqk7W2na5", "app_id": "Gxqk7W2na5.Shortcuts"},
        )
        self.assertIn("LAUNCHPAD_RESOURCES_VERIFIED", self.device_scripts[1])
        self.assertEqual(self.pushes, [])
        self.assertEqual(self.sdk_calls, [])

    def test_resource_failure_prevents_home_assignment_completion(self):
        self.fail_resources = True
        result, evidence = self.run_operation("activate")
        self.assertEqual(result, 1)
        self.assertFalse(evidence["completed"])
        self.assertEqual([call[0] for call in self.routing_calls], ["status", "apply"])
        self.assertNotIn("after", evidence)
        self.assertNotIn("status", evidence)
        self.assertEqual(self.sdk_calls, [])

    def test_incomplete_restore_can_query_then_recover_and_verify(self):
        self.initial_phase = "restore-failed"
        result, evidence = self.run_operation("restore")
        self.assertEqual(result, 0, evidence)
        self.assertEqual(
            [call[0] for call in self.routing_calls], ["query", "restore", "status"]
        )
        self.assertEqual(evidence["status"]["phase"], "restored")

    def test_failed_transport_cleanup_never_reports_completion(self):
        self.bad_probe = True
        result, evidence = self.run_operation("inspect")
        self.assertEqual(result, 1)
        self.assertFalse(evidence["completed"])
        self.assertEqual(self.sdk_calls, [])

    def test_missing_routing_evidence_never_reports_completion(self):
        self.bad_routing = True
        result, evidence = self.run_operation("inspect")
        self.assertEqual(result, 1)
        self.assertFalse(evidence["completed"])
        self.assertIn("routing/cleanup evidence", evidence["error"])
        self.assertEqual(self.sdk_calls, [])


class LaunchTargetTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="samshush-target-test-")
        self.addCleanup(temporary.cleanup)
        self.assets = Path(temporary.name)
        helper = self.assets / "payloads" / "q65d-2123"
        helper.mkdir(parents=True)
        (helper / (launchpad_routing.NAME + ".dll")).write_bytes(
            Q65D_BUILD.encode("utf-16-le")
        )
        self.policy = {
            "model": "QN55Q65DAGXZD",
            "build": Q65D_BUILD,
            "launchpad": {
                "helper": "payloads/q65d-2123",
                "routing_hashes": Q65D_HASHES,
                "verification": "fixture",
            },
        }

    def test_checked_in_profile_resolves_to_its_helper(self):
        policy = json.loads(frame.PROFILES["q65d-2123"].read_text())
        target = launchpad.launch_target(policy, frame.ASSETS)
        self.assertEqual(
            (target.model, target.build), (policy["model"], policy["build"])
        )
        self.assertEqual(target.helper, frame.ASSETS / "payloads/q65d-2123")
        self.assertEqual(set(target.routing_hashes), set(launchpad_routing.HASHES))
        frame.verify_files()

    def test_unpinned_or_malformed_profiles_are_refused(self):
        pins = self.policy["launchpad"]
        for policy in (
            {k: v for k, v in self.policy.items() if k != "launchpad"},
            {"model": "QN55Q65DAGXZD", "build": Q65D_BUILD},
            self.policy | {"launchpad": pins | {"extra": True}},
            self.policy | {"launchpad": pins | {"layout": "q65d-2123"}},
            self.policy
            | {"launchpad": {k: v for k, v in pins.items() if k != "verification"}},
            self.policy | {"launchpad": pins | {"helper": "../payloads/q65d-2123"}},
            self.policy | {"launchpad": pins | {"helper": "payloads/missing"}},
            self.policy | {"build": OTHER_BUILD},
        ):
            with (
                self.subTest(policy=policy.get("launchpad")),
                self.assertRaises(ValueError),
            ):
                launchpad.launch_target(policy, self.assets)


if __name__ == "__main__":
    unittest.main()
