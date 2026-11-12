"""Build the optional shortcut app with an existing Samsung signing profile."""

import argparse
import asyncio
import base64
import datetime
import gzip
import hashlib
import http.client
import json
import math
import os
import re
import secrets
import shlex
import subprocess
import tempfile
import xml.etree.ElementTree as ET
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "launcher"
WIDGET_NS = "{http://www.w3.org/ns/widgets}"
TIZEN_NS = "{http://tizen.org/ns/widgets}"
DS_NS = "{http://www.w3.org/2000/09/xmldsig#}"
WEATHER_ORIGIN = "https://api.open-meteo.com"
QUOTE_ORIGIN = "https://economia.awesomeapi.com.br"
TETHER_ORIGIN = "https://api.binance.com"
MARINE_ORIGIN = "https://marine-api.open-meteo.com"
NEWS_ORIGIN = "https://falkor-cda.bastian.globo.com"
NEWS_IMAGE_ORIGIN = "https://s2-g1.glbimg.com"
# The only origins each module may reach. moon.js makes no network requests.
MODULE_ORIGINS = {
    "quote.js": (QUOTE_ORIGIN, TETHER_ORIGIN),
    "sea.js": (MARINE_ORIGIN,),
    "forecast.js": (WEATHER_ORIGIN,),
    "moon.js": (),
}
RESOURCES = (
    "config.xml",
    "index.html",
    "styles.css",
    "ui.js",
    "device.js",
    "icon.png",
) + tuple(MODULE_ORIGINS)
SIGNATURES = ("author-signature.xml", "signature1.xml")
PRIVILEGES = {
    "http://tizen.org/privilege/application.launch",
    "http://tizen.org/privilege/tv.window",
    "http://tizen.org/privilege/internet",
}
# Widgets built on the Frame launcher carry its base files, a generated
# weather-config.json, extra privileges and some of the modules. That legacy
# shape is accepted only as the previous widget of an update.
PREVIOUS_BASE = (
    "config.xml",
    "index.html",
    "styles.css",
    "ui.js",
    "device.js",
    "weather.js",
    "icon.png",
    "water-lilies.jpg",
    "time-controls.js",
)
PREVIOUS_CONFIG = "weather-config.json"
PREVIOUS_MODULE_ORIGINS = MODULE_ORIGINS | {"news.js": (NEWS_ORIGIN, NEWS_IMAGE_ORIGIN)}
# Origins a module reached in an earlier release.
RETIRED_ORIGINS = {
    "quote.js": (QUOTE_ORIGIN,),
    "news.js": ("https://g1.globo.com",),
}
PREVIOUS_PRIVILEGES = PRIVILEGES | {
    "http://tizen.org/privilege/filesystem.read",
    "http://tizen.org/privilege/filesystem.write",
}


@dataclass(frozen=True)
class Identity:
    package: str
    app: str


@dataclass(frozen=True)
class Target:
    """Launcher and routing values that differ between supported TVs."""

    model: str
    build: str
    routing_hashes: dict
    helper: Path


def launch_target(policy, assets):
    """The profile pins the routing libraries and helper for its build."""
    import launchpad_routing

    pins = policy.get("launchpad")
    if not isinstance(pins, dict) or set(pins) != {
        "helper",
        "routing_hashes",
        "verification",
    }:
        raise ValueError("Launcher requires a verified model and build")
    helper = pins["helper"]
    if (
        not isinstance(helper, str)
        or re.fullmatch(r"payloads/[a-z0-9]+(-[a-z0-9]+)*", helper) is None
    ):
        raise ValueError("Invalid launcher helper location")
    dll = assets / helper / (launchpad_routing.NAME + ".dll")
    # The helper also refuses other builds, but this catches a misplaced binary before contacting the TV.
    if dll.is_symlink() or not dll.is_file():
        raise ValueError("Missing launcher helper for this build")
    if policy["build"].encode("utf-16-le") not in dll.read_bytes():
        raise ValueError("Launcher helper was built for another firmware")
    return Target(
        policy["model"],
        policy["build"],
        pins["routing_hashes"],
        assets / helper,
    )


def marker(output, name):
    values = [
        line.removeprefix(name + " ")
        for line in output.splitlines()
        if line.startswith(name + " ")
    ]
    if len(values) != 1:
        raise ValueError(f"Missing or ambiguous TV evidence: {name}")
    return values[0]


def verify_model(tv, model):
    connection = http.client.HTTPConnection(str(tv), 8001, timeout=5)
    try:
        connection.request("GET", "/api/v2/", headers={"Cache-Control": "no-cache"})
        response = connection.getresponse()
        data = response.read(65537)
        if response.status != 200 or len(data) > 65536:
            raise ValueError("Cannot verify TV model")
        identity = json.loads(data)
        if (
            not isinstance(identity, dict)
            or not isinstance(identity.get("device"), dict)
            or identity["device"].get("modelName") != model
        ):
            raise ValueError(f"Expected Samsung TV model {model}")
    finally:
        connection.close()


def device_command(script):
    encoded = base64.b64encode(gzip.compress(script.encode(), mtime=0)).decode()
    pipeline = f"printf %s {encoded} | base64 -d | gzip -dc | nsenter --mount=/proc/1/ns/mnt /bin/bash"
    command = "/bin/bash -o pipefail -c " + shlex.quote(pipeline)
    if len(command.encode()) > 65536:
        raise ValueError("TV command exceeds the transport command bound")
    return command


def parse_xml(data):
    if not 0 < len(data) <= 256 * 1024 or b"<!DOCTYPE" in data.upper():
        raise ValueError("Invalid or oversized widget XML")
    try:
        return ET.fromstring(data)
    except ET.ParseError as error:
        raise ValueError("Invalid widget XML") from error


def legacy_shape(resources, previous):
    """A previous widget built on the Frame launcher still carries its weather.js."""
    return previous and "weather.js" in resources


def network_origins(resources, previous=False):
    """Every set of access origins the packaged modules allow together."""
    legacy = legacy_shape(resources, previous)
    # The legacy base carried weather.js, which used the forecast API.
    allowed = [{WEATHER_ORIGIN} if legacy else set()]
    table = PREVIOUS_MODULE_ORIGINS if legacy else MODULE_ORIGINS
    for name, origins in table.items():
        if name not in resources:
            continue
        options = [set(origins)]
        if legacy and name in RETIRED_ORIGINS:
            options.append(set(RETIRED_ORIGINS[name]))
        allowed = [chosen | option for chosen in allowed for option in options]
    return allowed


def manifest_identity(data, resources=RESOURCES, *, previous=False):
    widget = parse_xml(data)
    for tag in (TIZEN_NS + "application", WIDGET_NS + "content", TIZEN_NS + "profile"):
        if len(widget.findall(tag)) != 1:
            raise ValueError("Missing or duplicate widget configuration element")
    application = widget.find(TIZEN_NS + "application")
    if widget.tag != WIDGET_NS + "widget" or application is None:
        raise ValueError("Missing widget application identity")
    package, app = application.get("package", ""), application.get("id", "")
    if not re.fullmatch(r"[A-Za-z0-9]{10}", package) or not re.fullmatch(
        re.escape(package) + r"\.[A-Za-z][A-Za-z0-9_-]{0,49}", app
    ):
        raise ValueError("Invalid SDK widget identity")
    content = widget.find(WIDGET_NS + "content")
    profile = widget.find(TIZEN_NS + "profile")
    if (
        content is None
        or content.get("src") != "index.html"
        or profile is None
        or profile.get("name") != "tv"
        or application.get("required_version") != "9.0"
    ):
        raise ValueError("Unexpected widget entry point or TV profile")
    nodes = widget.findall(TIZEN_NS + "privilege")
    privileges = [node.get("name") for node in nodes]
    permitted = PREVIOUS_PRIVILEGES if legacy_shape(resources, previous) else PRIVILEGES
    if (
        len(privileges) != len(permitted)
        or set(privileges) != permitted
        or any(set(node.attrib) != {"name"} or len(node) for node in nodes)
    ):
        raise ValueError("Unexpected launcher privileges")
    access = widget.findall(WIDGET_NS + "access")
    declared = [node.get("origin") for node in access]
    valid_access = (
        len(declared) == len(set(declared))
        and set(declared) in network_origins(resources, previous)
        and all(
            set(node.attrib) == {"origin", "subdomains"}
            and node.get("subdomains") == "false"
            and not len(node)
            for node in access
        )
    )
    if not valid_access:
        raise ValueError(
            "Launcher network access must be limited to the origins of its modules"
        )
    if any(
        widget.findall(tag)
        for tag in (
            TIZEN_NS + "app-control",
            TIZEN_NS + "allow-navigation",
            TIZEN_NS + "service",
            TIZEN_NS + "service-application",
        )
    ):
        raise ValueError(
            "Launcher must not register navigation, services or Home on install"
        )
    return Identity(package, app)


def unique_json_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON property")
        result[key] = value
    return result


def weather_config(data):
    """A previous widget's generated weather setting: off or one coordinate pair."""
    if not isinstance(data, bytes) or not 0 < len(data) <= 1024:
        raise ValueError("Invalid weather configuration size")
    try:
        value = json.loads(data.decode("utf-8"), object_pairs_hook=unique_json_object)
    except (UnicodeError, json.JSONDecodeError) as error:
        raise ValueError("Invalid weather configuration JSON") from error
    if not isinstance(value, dict) or set(value) not in (
        set(),
        {"latitude", "longitude"},
    ):
        raise ValueError(
            "Weather configuration must contain only latitude and longitude"
        )
    for key, limit in (("latitude", 90), ("longitude", 180)):
        if key in value and (
            type(value[key]) not in (int, float)
            or not -limit <= value[key] <= limit
            or not math.isfinite(value[key])
        ):
            raise ValueError("Invalid weather coordinates")
    return value


def source_files(source=SOURCE):
    files = {}
    for name in RESOURCES:
        path = source / name
        if path.is_symlink() or not path.is_file() or path.stat().st_size > 1024 * 1024:
            raise ValueError(f"Missing or invalid launcher resource: {name}")
        files[name] = path.read_bytes()
    manifest_identity(files["config.xml"], files)
    return files


def signed_widget_resources(path, source=SOURCE, *, previous=False):
    """Validate signed resources; previous releases need not match this checkout."""
    expected = None if previous else source_files(source)
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 8 * 1024 * 1024:
        raise ValueError("Invalid signed widget file")
    try:
        with zipfile.ZipFile(path) as archive:
            members = archive.infolist()
            names = [item.filename for item in members]
            if expected is not None:
                resources = tuple(expected)
            elif set(names) == set(RESOURCES + SIGNATURES):
                resources = RESOURCES
            else:
                modules = tuple(
                    name for name in PREVIOUS_MODULE_ORIGINS if name in names
                )
                resources = PREVIOUS_BASE + modules + (PREVIOUS_CONFIG,)
            if len(names) != len(set(names)) or set(names) != set(
                resources + SIGNATURES
            ):
                raise ValueError(
                    "Widget has missing, duplicate or unexpected resources"
                )
            if any(
                item.file_size
                > (
                    1024
                    if item.filename == PREVIOUS_CONFIG
                    else (8 if item.filename == "water-lilies.jpg" else 1) * 1024 * 1024
                )
                or item.flag_bits & 1
                for item in members
            ):
                raise ValueError("Widget member is oversized or encrypted")
            actual = {name: archive.read(name) for name in names}
    except (zipfile.BadZipFile, RuntimeError) as error:
        raise ValueError("Cannot read signed widget") from error
    if expected is not None and any(
        actual[name] != data for name, data in expected.items()
    ):
        raise ValueError("Signed widget differs from current launcher source")
    identity = manifest_identity(actual["config.xml"], resources, previous=previous)
    if PREVIOUS_CONFIG in resources:
        weather_config(actual[PREVIOUS_CONFIG])
    for name in SIGNATURES:
        signature = parse_xml(actual[name])
        if signature.tag != DS_NS + "Signature":
            raise ValueError("Missing XML signature")
        value = signature.findtext(DS_NS + "SignatureValue", "").strip()
        certificates = signature.findall(".//" + DS_NS + "X509Certificate")
        if not value or not certificates or any(not node.text for node in certificates):
            raise ValueError("Incomplete widget signature")
        references = signature.findall(DS_NS + "SignedInfo/" + DS_NS + "Reference")
        covered = set()
        for reference in references:
            uri = reference.get("URI", "")
            if uri.startswith("#"):
                continue  # SDK signature-properties reference, not a resource.
            if uri not in actual or uri == name or uri in covered:
                raise ValueError("Unexpected or duplicate signature resource reference")
            method = reference.find(DS_NS + "DigestMethod")
            # The SDK's XML-security encoder wraps Base64 at 76 columns.
            digest = re.sub(
                r"[ \t\r\n]", "", reference.findtext(DS_NS + "DigestValue", "")
            )
            algorithms = {
                "http://www.w3.org/2001/04/xmlenc#sha256": hashlib.sha256,
                "http://www.w3.org/2001/04/xmlenc#sha512": hashlib.sha512,
            }
            algorithm = (
                algorithms.get(method.get("Algorithm")) if method is not None else None
            )
            if algorithm is None:
                raise ValueError("Unsupported widget digest algorithm")
            expected_digest = base64.b64encode(algorithm(actual[uri]).digest()).decode()
            if digest != expected_digest:
                raise ValueError("Widget signature resource digest mismatch")
            covered.add(uri)
        required = set(resources)
        if name == "signature1.xml":
            required.add("author-signature.xml")
        if not required <= covered:
            raise ValueError("Widget signature omits launcher resources")
    return identity, {name: actual[name] for name in resources}


def verify_widget(path, source=SOURCE):
    """Match static resources to this checkout.

    XML signature presence and resource digests are checked here. This is not
    cryptographic validation of Samsung's certificate chain; TV installation
    validates trust.
    """
    return signed_widget_resources(path, source)[0]


def build(
    sdk,
    profile,
    output,
    source=SOURCE,
    *,
    cli=None,
):
    """Use the official packager without logging profile credentials."""
    if cli is None:
        if sdk is None:
            raise ValueError("A Tizen SDK or executable CLI path is required")
        cli = sdk / "tools/ide/bin/tizen"
    else:
        cli = Path(cli)
    if not cli.is_file() or not os.access(cli, os.X_OK):
        raise ValueError("Official Tizen CLI is unavailable")
    if not profile or len(profile) > 128 or any(ord(char) < 32 for char in profile):
        raise ValueError("Invalid signing profile name")
    files = source_files(source)
    output.mkdir(parents=True, exist_ok=False, mode=0o700)
    with tempfile.TemporaryDirectory(prefix="stage-", dir=output) as directory:
        stage = Path(directory)
        unsigned = stage / "Shortcuts.wgt"
        with zipfile.ZipFile(
            unsigned, "w", compression=zipfile.ZIP_DEFLATED
        ) as archive:
            for name, data in files.items():
                archive.writestr(name, data)
        signed = stage / "signed"
        signed.mkdir(mode=0o700)
        try:
            result = subprocess.run(
                [
                    str(cli),
                    "package",
                    "-t",
                    "wgt",
                    "-s",
                    profile,
                    "-o",
                    str(signed),
                    "--",
                    str(unsigned),
                ],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=90,
                check=False,
            )
        except subprocess.TimeoutExpired as error:
            raise ValueError(
                "SDK signing timed out; check the saved signing profile"
            ) from error
        if result.returncode:
            raise ValueError(
                "SDK signing failed; unlock the saved profile in Certificate Manager"
            )
        artifact = signed / "Shortcuts.wgt"
        identity, _ = signed_widget_resources(artifact, source)
        target = output / "Shortcuts.wgt"
        artifact.replace(target)
        target.chmod(0o600)
    receipt = {
        "app_id": identity.app,
        "package_id": identity.package,
        "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
        "source_sha256": {
            name: hashlib.sha256(data).hexdigest() for name, data in files.items()
        },
        "installed": False,
    }
    receipt_path = output / "build.json"
    receipt_path.write_text(json.dumps(receipt, indent=2) + "\n")
    receipt_path.chmod(0o600)
    return target


def registration_script(
    identity, target, *, verify_resources=False, resources=None, previous=False
):
    """Read the one app's registration, optionally checking its installed resources."""
    files = source_files() if resources is None else resources
    if manifest_identity(files["config.xml"], files, previous=previous) != identity:
        raise ValueError("Launcher identity differs from this checkout")

    script = f"""set -euo pipefail
[[ $(id -u) == 0 ]]
grep -Fxq 'BUILD_ID={target.build}' /etc/os-release
db=/opt/dbspace/.pkgmgr_parser.db
packages=$(sqlite3 -readonly "$db" "SELECT count(*) FROM package_info WHERE package='{identity.package}';")
apps=$(sqlite3 -readonly "$db" "SELECT count(*) FROM package_app_info WHERE app_id='{identity.app}' AND package='{identity.package}' AND app_disable='false';")
printf 'LAUNCHPAD_PACKAGE_COUNT %s\\n' "$packages"
printf 'LAUNCHPAD_APP_COUNT %s\\n' "$apps"
"""
    if verify_resources:
        script += f"""[[ $packages == 1 && $apps == 1 ]]
root=/opt/usr/apps/{identity.package}/res/wgt
[[ -d /opt/usr/apps/{identity.package} && ! -L /opt/usr/apps/{identity.package} ]]
[[ -d /opt/usr/apps/{identity.package}/res && ! -L /opt/usr/apps/{identity.package}/res ]]
[[ -d $root && ! -L $root ]]
"""
        for name, data in files.items():
            digest = hashlib.sha256(data).hexdigest()
            script += f'[[ -f "$root/{name}" && ! -L "$root/{name}" ]]\n'
            script += (
                f'[[ $(sha256sum "$root/{name}" | cut -d " " -f 1) == {digest} ]]\n'
            )
        script += "echo LAUNCHPAD_RESOURCES_VERIFIED\n"
    return script


def run(args, cli):
    """Device operations stay separate from packaging and from privacy controls."""
    from samsung_tv_root.archive_root import probe
    from samsung_tv_root.sdb import SdbClient, find_sdb

    import launchpad_routing

    target = launch_target(cli.policy(), cli.ASSETS)
    identity = manifest_identity((SOURCE / "config.xml").read_bytes())
    needs_widget = args.operation in {"install", "update", "activate"}
    previous_path = getattr(args, "previous_widget", None)
    if needs_widget:
        if args.widget is None or verify_widget(args.widget) != identity:
            raise ValueError("A matching signed --widget is required")
    elif args.widget is not None:
        raise ValueError("--widget is only used by install, update or activate")
    if args.operation == "update":
        if (
            previous_path is None
            or signed_widget_resources(previous_path, previous=True)[0] != identity
        ):
            raise ValueError("Update requires a matching signed --previous-widget")
    elif previous_path is not None:
        raise ValueError("--previous-widget is only used by update")
    args.logs.mkdir(parents=True, exist_ok=True, mode=0o700)
    report = args.logs / (
        datetime.datetime.now(datetime.UTC).strftime("%Y%m%dT%H%M%SZ")
        + f"-launchpad-{args.operation}-{secrets.token_hex(3)}.json"
    )
    evidence = {
        "operation": args.operation,
        "app_id": identity.app,
        "completed": False,
        "results": [],
    }

    def freeze(path, *, previous=False):
        with path.open("rb") as original:
            widget_bytes = original.read(8 * 1024 * 1024 + 1)
        if len(widget_bytes) > 8 * 1024 * 1024:
            raise ValueError("Signed widget exceeds the upload bound")
        with tempfile.NamedTemporaryFile(
            prefix="launchpad-previous-" if previous else "launchpad-verified-",
            suffix=".wgt",
            dir=args.logs,
            delete=False,
        ) as frozen:
            frozen.write(widget_bytes)
            frozen_path = Path(frozen.name)
        frozen_identity, resources = signed_widget_resources(
            frozen_path, SOURCE, previous=previous
        )
        if frozen_identity != identity:
            raise ValueError("Frozen widget identity differs from the launcher")
        return frozen_path, resources, hashlib.sha256(widget_bytes).hexdigest()

    frozen_widget = None
    widget_resources = previous_resources = None
    if needs_widget:
        frozen_widget, widget_resources, widget_digest = freeze(args.widget)
        evidence["verified_widget"] = str(frozen_widget)
        evidence["widget_sha256"] = widget_digest
    if args.operation == "update":
        frozen_previous, previous_resources, previous_digest = freeze(
            previous_path, previous=True
        )
        evidence["previous_widget"] = str(frozen_previous)
        evidence["previous_widget_sha256"] = previous_digest

    def save():
        temporary = report.with_suffix(".tmp")
        with temporary.open("w") as output:
            os.chmod(temporary, 0o600)
            json.dump(evidence, output, indent=2)
            output.write("\n")
        temporary.replace(report)

    def execute(script):
        result = asyncio.run(
            probe(
                str(args.tv),
                model=target.model,
                callback_host=str(args.callback_host) if args.callback_host else None,
                accept_timeout=180,
                command_timeout=90,
                commands=(device_command(script),),
                payloads=cli.ASSETS / "payloads",
            )
        )
        evidence["results"].append(result)
        save()
        cli.check_result(result)
        commands = result.get("commands", [])
        if len(commands) != 1:
            raise ValueError("Incomplete launcher operation evidence")
        return commands[0]["stdout"]

    artifacts = {
        suffix: (target.helper / (launchpad_routing.NAME + suffix)).read_bytes()
        for suffix in (".dll", ".runtimeconfig.json")
    }

    def routing(operation):
        options = (
            {"package_id": identity.package, "app_id": identity.app}
            if operation == "apply"
            else {}
        )
        script = launchpad_routing.render_script(
            operation,
            artifacts,
            build=target.build,
            hashes=target.routing_hashes,
            **options,
        )
        if operation == "apply":
            script = (
                registration_script(
                    identity, target, verify_resources=True, resources=widget_resources
                )
                + script
            )
        return launchpad_routing.parse_output(execute(script), build=target.build)

    def check_resources(resources=None, *, previous=False):
        output = execute(
            registration_script(
                identity,
                target,
                verify_resources=True,
                resources=resources,
                previous=previous,
            )
        )
        if output.splitlines().count("LAUNCHPAD_RESOURCES_VERIFIED") != 1:
            raise ValueError("Missing launcher resource verification")

    def checked_upload(script, marker):
        if execute(script).splitlines().count(marker) != 1:
            raise ValueError("Missing launcher upload verification")

    def require_owned_home(state):
        receipt = state["receipt"]
        if (
            state["phase"] != "applied"
            or receipt is None
            or receipt["Package"] != identity.package
            or receipt["App"] != identity.app
        ):
            raise ValueError("Update requires the matching applied Home assignment")

    def sdk(client, command):
        result = client.run(
            ("-s", client.serial, "shell", "0", *command), check=False, timeout=90
        )
        evidence["results"].append(
            {
                "sdk_command": command,
                "returncode": result.returncode,
                "stdout": result.stdout,
                "stderr": result.stderr,
            }
        )
        save()
        if result.returncode:
            raise ValueError("SDK operation failed; inspect its report before retrying")
        return result.stdout + result.stderr

    save()
    try:
        verify_model(args.tv, target.model)
        before = routing(
            "query"
            if args.operation in {"inspect", "install", "launch", "restore"}
            else "status"
        )
        evidence["before"] = before
        if args.operation in {"install", "update"}:
            if args.operation == "update":
                require_owned_home(before)
                check_resources(previous_resources, previous=True)
            else:
                output = execute(registration_script(identity, target))
                if (
                    marker(output, "LAUNCHPAD_PACKAGE_COUNT") != "0"
                    or marker(output, "LAUNCHPAD_APP_COUNT") != "0"
                ):
                    raise ValueError(
                        "Launcher is already registered; inspect it before replacing the package"
                    )
            client = SdbClient(find_sdb(), str(args.tv))
            client.connect()
            client.require_device()
            digest = evidence["widget_sha256"]
            remote = (
                PurePosixPath("/home/owner/share/tmp/sdk_tools")
                / f"Samshush-{digest[:16]}-{secrets.token_hex(4)}.wgt"
            )
            evidence.update(widget_sha256=digest, staged_widget=str(remote))
            save()
            client.push(frozen_widget, remote)
            checked_upload(
                f"""set -euo pipefail
[[ $(id -u) == 0 ]]
grep -Fxq 'BUILD_ID={target.build}' /etc/os-release
path={remote}
[[ -f $path && ! -L $path && $(sha256sum "$path" | cut -d " " -f 1) == {digest} ]]
echo LAUNCHPAD_UPLOAD_VERIFIED
""",
                "LAUNCHPAD_UPLOAD_VERIFIED",
            )
            output = sdk(client, ("vd_appinstall", identity.app, str(remote)))
            if "install completed" not in output or "install failed" in output.lower():
                raise ValueError(
                    "Installation was not confirmed; inspect before retrying"
                )
            check_resources(widget_resources)
            if args.operation == "update":
                after = routing("status")
                evidence["after"] = after
                require_owned_home(after)
                if any(after[key] != before[key] for key in ("receipt", "current")):
                    raise ValueError("Home assignment changed during the app update")
            # The installer may remove its upload. Remove only our exact verified bytes.
            checked_upload(
                f"""set -euo pipefail
[[ $(id -u) == 0 ]]
grep -Fxq 'BUILD_ID={target.build}' /etc/os-release
path={remote}
if [[ -e $path || -L $path ]]; then
 [[ -f $path && ! -L $path && $(sha256sum "$path" | cut -d " " -f 1) == {digest} ]]
 rm -- "$path"
fi
[[ ! -e $path && ! -L $path ]]
echo LAUNCHPAD_UPLOAD_CLEANED
""",
                "LAUNCHPAD_UPLOAD_CLEANED",
            )
            print(
                "Shortcut app updated; Home assignment is unchanged. Previous signed widget retained."
                if args.operation == "update"
                else "Shortcut app installed. Home assignment is unchanged; launch and check its controls before activation."
            )
        elif args.operation == "launch":
            check_resources()
            client = SdbClient(find_sdb(), str(args.tv))
            client.connect()
            client.require_device()
            output = sdk(client, ("execute", identity.app))
            if "successfully launched" not in output:
                raise ValueError("App launch was not confirmed")
            print(
                "Shortcut app launched. Check HDMI, Settings, Art Mode and Back on the TV."
            )
        elif args.operation == "activate":
            evidence["after"] = routing("apply")
            evidence["status"] = routing("status")
            print(
                "Home assigned to Shortcuts. Physical Home-button and restart checks remain separate."
            )
        elif args.operation == "restore":
            evidence["after"] = routing("restore")
            evidence["status"] = routing("status")
            print(
                "Original Home assignment restored; the shortcut app remains installed."
            )
        elif args.operation == "archive":
            if before["phase"] not in {"restored", "rolled-back"}:
                raise ValueError(
                    "Only a restored or rolled-back Home journal can be archived"
                )
            output = execute(launchpad_routing.journal_script(target.build))
            digest = marker(output, "LAUNCHPAD_JOURNAL_SHA256")
            raw = base64.b64decode(
                marker(output, "LAUNCHPAD_JOURNAL_RAW"), validate=True
            )
            if (
                hashlib.sha256(raw).hexdigest() != digest
                or json.loads(raw) != before["receipt"]
            ):
                raise ValueError("Saved journal differs from the verified receipt")
            evidence["archived_journal"] = {
                "sha256": digest,
                "raw": base64.b64encode(raw).decode(),
            }
            save()
            stamp = datetime.datetime.now(datetime.UTC).strftime("%Y%m%dT%H%M%SZ")
            output = execute(
                launchpad_routing.journal_script(
                    target.build, digest=digest, stamp=stamp
                )
            )
            evidence["archived_journal"]["path"] = marker(
                output, "LAUNCHPAD_JOURNAL_ARCHIVED"
            )
            evidence["after"] = routing("query")
            if evidence["after"]["phase"] != "absent":
                raise ValueError("Home journal is still present after archiving")
            print(
                "Restored Home journal archived on the TV and saved in this report; activation is available again."
            )
        else:
            print("Home routing journal:", before["phase"])
        evidence["completed"] = True
    except Exception as error:
        evidence["error"] = str(error)
        print(f"FAILED: {error}. Inspect the saved report before retrying.")
    finally:
        save()
        print(f"Report: {report}")
    return 0 if evidence["completed"] else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    command = parser.add_mutually_exclusive_group(required=True)
    command.add_argument(
        "--sdk", type=Path, help="SDK root containing tools/ide/bin/tizen"
    )
    command.add_argument(
        "--cli", type=Path, help="Executable Tizen CLI or local wrapper"
    )
    parser.add_argument("--profile", required=True)
    parser.add_argument(
        "--output", required=True, type=Path, help="Fresh private output directory"
    )
    args = parser.parse_args()
    try:
        target = build(
            args.sdk.expanduser().resolve() if args.sdk else None,
            args.profile,
            args.output.resolve(),
            cli=args.cli.expanduser().resolve() if args.cli else None,
        )
    except (OSError, ValueError) as error:
        parser.exit(1, f"{error}\n")
    print(f"Signed launcher: {target}")


if __name__ == "__main__":
    main()
