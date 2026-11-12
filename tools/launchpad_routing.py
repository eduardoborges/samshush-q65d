"""Exact-build native Home assignment; transport and signed installation are external."""

import base64
import hashlib
import json
import os
import re
import shlex
import subprocess
from pathlib import Path

# The Q65D build compiled into the checked-in helper; source_for() swaps it for another build.
BUILD = "T-NKLDUABC-0090-REL-202603190159"
# The only SDK that rebuilds the checked-in helpers byte for byte. mise.toml pins the same one.
SDK = "6.0.428"

JOURNAL = "/opt/usr/share/samshush-home-v1"
BUILD_PATTERN = r"T-[A-Z0-9]+-[0-9]{4}-REL-[0-9]{12}"
NAME = "LaunchpadRouting"
HOME_KEY = "db/appfw/home_appid"
KEYS = {
    HOME_KEY,
    "db/appfw/overlay_home_appid",
    "db/appfw/startup_appid",
    "db/appfw/booting_appid_backup",
    "db/first_screen/type",
}
PHASES = {
    "prepared",
    "applying",
    "applied",
    "restoring",
    "restored",
    "rolling-back",
    "rolled-back",
    "restore-failed",
    "recovery-needed",
}
HASHES = {
    "/usr/lib/libaul.so.0": "483b96db6d3c52563d9dedfd466cfd6fe9a27ad0b6e15e615de923ffe83e83f1",
    "/usr/lib/libbundle.so.0": "22d6538034ddce6b9810bc1fbd1311b21d00767c7674f3026fc18fcf1d3e865c",
    "/usr/lib/libvconf.so.0": "5b91888c7e91102c7ac59c648541d7d6827d550fa3d0fe226c9e135af39e95eb",
    "/usr/lib/libcapi-appfw-app-operation-tv.so.0.1.0": "ff9e230125ccb797f6437631f2b79144d3d40980efe1dcc8a12bfaf2ca8e97f7",
    "/usr/lib/libcapi-appfw-app-control.so.0.23.0": "9289ee834e618079643be73df93365c8d3572b50b3b85c3c77d3dbebf915612e",
}
PROJECT = """<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup>
<OutputType>Exe</OutputType><TargetFramework>net6.0</TargetFramework>
<ImplicitUsings>disable</ImplicitUsings><Nullable>enable</Nullable>
<Deterministic>true</Deterministic><RollForward>Major</RollForward>
<DebugType>none</DebugType><PathMap>$(MSBuildProjectDirectory)=/samshush/LaunchpadRouting</PathMap>
</PropertyGroup></Project>
"""


AUDIT = r"""set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
export LC_ALL=C
[[ $(id -u) == 0 ]]
grep -Fxq BUILD_ID=@@BUILD@@ /etc/os-release
shopt -s nullglob
echo 'IDENTITY'
uname -m
echo 'ROUTING LIBRARIES'
for path in /usr/lib/libaul.so* /usr/lib/libbundle.so* /usr/lib/libvconf.so* /usr/lib/libcapi-appfw-app-operation-tv.so* /usr/lib/libcapi-appfw-app-control.so*; do
 ls -l "$path"
 if [[ -f $path && ! -L $path ]]; then sha256sum "$path"; fi
done
echo 'RUNTIME'
for path in /usr/bin/dotnet /usr/bin/tvctx-manager; do
 if [[ -e $path ]]; then ls -l "$path"; sha256sum "$path"; else echo "ABSENT $path"; fi
done
for path in /usr/share/dotnet/shared/Microsoft.NETCore.App/*; do echo "RUNTIME VERSION $path"; done
echo 'HOME KEYS'
for key in @@KEYS@@; do
 vconftool get "$key" || echo "UNAVAILABLE $key"
done
echo 'ROUTING PROCESS'
for path in /proc/[0-9]*/exe; do
 if [[ $(readlink "$path" 2>/dev/null || true) == /usr/bin/tvctx-manager ]]; then
  awk '/^Uid:/ {print "TVCTX UID", $2, $3}' "${path%/exe}/status"
 fi
done
echo 'JOURNALS'
for path in @@JOURNAL@@ /run/frame-runtime-v1.lock; do
 if [[ -e $path || -L $path ]]; then ls -ld "$path"; else echo "ABSENT $path"; fi
done
echo 'REGISTRATIONS'
sqlite3 -readonly -separator $'\t' /opt/dbspace/.pkgmgr_parser.db "SELECT app_id,app_disable,app_exec FROM package_app_info WHERE app_id IN ('com.samsung.tv.csfs','org.tizen.tv-viewer','org.tizen.menu','org.tizen.art-app') OR package='@@PACKAGE@@' ORDER BY app_id;"
echo 'APPS'
sqlite3 -readonly -separator $'\t' /opt/dbspace/.pkgmgr_parser.db "SELECT a.app_id,a.app_disable,a.app_nodisplay,a.package,COALESCE(l.app_label,'') FROM package_app_info a LEFT JOIN package_app_localized_info l ON l.app_id=a.app_id AND l.app_locale='No Locale' ORDER BY a.app_id;" || echo 'APPS UNAVAILABLE'
echo 'LAUNCHPAD AUDIT COMPLETE; nothing changed'
"""


def render_audit(build, package_id):
    if re.fullmatch(BUILD_PATTERN, build) is None:
        raise ValueError("Unexpected build identifier")
    if re.fullmatch(r"[A-Za-z0-9]{10}", package_id) is None:
        raise ValueError("Unexpected launcher package")
    return (
        AUDIT.replace("@@BUILD@@", shlex.quote(build))
        .replace("@@KEYS@@", " ".join(shlex.quote(key) for key in sorted(KEYS)))
        .replace("@@JOURNAL@@", shlex.quote(JOURNAL))
        .replace("@@PACKAGE@@", package_id)
    )


def validate_identity(package_id, app_id):
    if (
        not isinstance(package_id, str)
        or re.fullmatch(r"[A-Za-z0-9]{10}", package_id) is None
        or not isinstance(app_id, str)
        or re.fullmatch(
            re.escape(package_id) + r"\.[A-Za-z][A-Za-z0-9_.-]{0,51}", app_id
        )
        is None
    ):
        raise ValueError("Expected a ten-character widget package and matching app ID")
    return package_id, app_id


def source_for(build):
    """The helper writes its build into the recovery receipt, so each build needs its own binary."""
    if re.fullmatch(BUILD_PATTERN, build) is None:
        raise ValueError("Unexpected build identifier")
    constant = f'const string Build = "{BUILD}";'
    if SOURCE.count(constant) != 1:
        raise ValueError("Helper source no longer has one build constant")
    return SOURCE.replace(constant, f'const string Build = "{build}";')


def build_helper(dotnet, output, build=BUILD):
    """Build in a fresh directory using the existing pinned SDK; never contact a TV."""
    output = Path(output)
    env = os.environ | {
        "DOTNET_CLI_TELEMETRY_OPTOUT": "1",
        "DOTNET_SKIP_FIRST_TIME_EXPERIENCE": "1",
        "DOTNET_NOLOGO": "1",
        "DOTNET_CLI_HOME": str(
            Path(__file__).resolve().parents[1] / ".local/dotnet-home"
        ),
    }
    version = subprocess.check_output(
        [str(dotnet), "--version"], text=True, timeout=15, env=env
    ).strip()
    if version != SDK:
        raise ValueError(f"Expected .NET SDK {SDK}, got {version}")
    output.mkdir(parents=True, exist_ok=False)
    (output / f"{NAME}.cs").write_text(source_for(build))
    (output / f"{NAME}.csproj").write_text(PROJECT)
    (output / "NuGet.Config").write_text(
        "<configuration><packageSources><clear/></packageSources></configuration>"
    )
    subprocess.run(
        [
            str(dotnet),
            "build",
            str(output / f"{NAME}.csproj"),
            "-c",
            "Release",
            "-o",
            str(output / "out"),
            "--nologo",
            "--verbosity",
            "quiet",
        ],
        check=True,
        timeout=180,
        env=env,
    )
    return {
        suffix: (output / "out" / (NAME + suffix)).read_bytes()
        for suffix in (".dll", ".runtimeconfig.json")
    }


def render_script(
    operation, artifacts, *, package_id=None, app_id=None, build=BUILD, hashes=HASHES
):
    """Render one fixed operation. Caller must verify the model and signed widget."""
    if operation not in {"query", "apply", "status", "restore"}:
        raise ValueError("Unknown Home-routing operation")
    if operation == "apply":
        validate_identity(package_id, app_id)
    elif package_id is not None or app_id is not None:
        raise ValueError("Only apply accepts a target identity")
    if re.fullmatch(BUILD_PATTERN, build) is None:
        raise ValueError("Unexpected build identifier")
    # The helper imports exactly these libraries. Profile digests end up in the shell script.
    if set(hashes) != set(HASHES) or any(
        not isinstance(digest, str) or re.fullmatch(r"[0-9a-f]{64}", digest) is None
        for digest in hashes.values()
    ):
        raise ValueError("Unexpected Home-routing library pins")
    staging = []
    for suffix in (".dll", ".runtimeconfig.json"):
        data = artifacts[suffix]
        if not isinstance(data, bytes) or not 0 < len(data) <= 262144:
            raise ValueError("Invalid Home-routing helper artifact")
        name = NAME + suffix
        staging.append(
            f'printf %s {base64.b64encode(data).decode()} | base64 -d > "$stage/{name}"'
        )
        staging.append(
            f'[[ $(sha256sum "$stage/{name}" | cut -d " " -f 1) == {hashlib.sha256(data).hexdigest()} ]]'
        )
    registration = ""
    if operation == "apply":
        # IDs are validated ASCII, so they cannot introduce SQL or shell syntax.
        registration = f"""
registered=$(sqlite3 -readonly /opt/dbspace/.pkgmgr_parser.db "SELECT count(*) FROM package_app_info a JOIN package_info p ON p.package=a.package WHERE a.app_id='{app_id}' AND a.package='{package_id}' AND a.app_component='uiapp' AND a.app_type='webapp' AND a.app_package_type='wgt' AND p.package_type='wgt' AND a.app_disable='false' AND p.package_disable='false' AND a.app_root_path='/opt/usr/apps/{package_id}';")
[[ $registered == 1 ]] || {{ echo 'Target is not the verified enabled web application' >&2; exit 1; }}
[[ -d /opt/usr/apps/{package_id} && ! -L /opt/usr/apps/{package_id} ]]
"""
    replacements = {
        "@@BUILD@@": shlex.quote(build),
        "@@JOURNAL@@": shlex.quote(JOURNAL),
        "@@HASHES@@": "\n".join(f"{digest}  {path}" for path, digest in hashes.items()),
        "@@STAGING@@": "\n".join(staging),
        "@@REGISTRATION@@": registration,
        "@@ARGS@@": " ".join(
            map(shlex.quote, (operation, package_id or "", app_id or ""))
        ),
    }
    script = SCRIPT
    for token, value in replacements.items():
        script = script.replace(token, value)
    return script


JOURNAL_SCRIPT = r"""set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
export LC_ALL=C
umask 077
[[ $(id -u) == 0 ]]
grep -Fxq BUILD_ID=@@BUILD@@ /etc/os-release
lock=/run/frame-runtime-v1.lock
state=@@JOURNAL@@
mkdir -m 700 "$lock" || { echo 'Another operation may be running' >&2; exit 1; }
trap 'rmdir "$lock"' EXIT
[[ -d $state && ! -L $state && $(stat -c '%u:%a' "$state") == 0:700 ]]
shopt -s nullglob dotglob
entries=("$state"/*)
[[ ${#entries[@]} == 1 && ${entries[0]} == "$state/state.json" ]]
receipt=$state/state.json
[[ -f $receipt && ! -L $receipt && $(stat -c '%u:%a' "$receipt") == 0:600 && $(stat -c %s "$receipt") -le 16384 ]]
digest=$(sha256sum "$receipt" | cut -d ' ' -f 1)
@@ACTION@@
"""
READ_ACTION = r"""printf 'LAUNCHPAD_JOURNAL_SHA256 %s\n' "$digest"
printf 'LAUNCHPAD_JOURNAL_RAW %s\n' "$(base64 < "$receipt" | tr -d '\n')"
"""
ARCHIVE_ACTION = r"""[[ $digest == @@DIGEST@@ ]] || { echo 'Journal changed since it was verified' >&2; exit 1; }
target=@@TARGET@@
[[ ! -e $target && ! -L $target ]]
mv -- "$state" "$target"
sync
[[ ! -e $state && -d $target && ! -L $target ]]
printf 'LAUNCHPAD_JOURNAL_ARCHIVED %s\n' "$target"
"""


def journal_script(build=BUILD, *, digest=None, stamp=None):
    """Read the committed Home journal, or rename those exact bytes out of the way.

    Activation refuses any existing journal, so a verified restore is archived
    beside it instead of deleted.
    """
    if re.fullmatch(BUILD_PATTERN, build) is None:
        raise ValueError("Unexpected build identifier")
    if digest is None and stamp is None:
        action = READ_ACTION
    elif (
        isinstance(digest, str)
        and re.fullmatch(r"[0-9a-f]{64}", digest) is not None
        and isinstance(stamp, str)
        and re.fullmatch(r"[0-9]{8}T[0-9]{6}Z", stamp) is not None
    ):
        action = ARCHIVE_ACTION.replace("@@DIGEST@@", digest).replace(
            "@@TARGET@@", shlex.quote(f"{JOURNAL}.archived-{stamp}")
        )
    else:
        raise ValueError("Archiving needs the verified journal digest and a UTC stamp")
    return (
        JOURNAL_SCRIPT.replace("@@BUILD@@", shlex.quote(build))
        .replace("@@JOURNAL@@", shlex.quote(JOURNAL))
        .replace("@@ACTION@@", action)
    )


def parse_output(output, build=BUILD):
    rows = [
        line.removeprefix("LAUNCHPAD_ROUTING_JSON=")
        for line in output.splitlines()
        if line.startswith("LAUNCHPAD_ROUTING_JSON=")
    ]
    if len(rows) != 1 or output.splitlines().count("LAUNCHPAD_ROUTING_CLEANED") != 1:
        raise ValueError("Missing or ambiguous routing/cleanup evidence")

    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("Duplicate routing evidence property")
            result[key] = value
        return result

    def state(value):
        return (
            isinstance(value, dict)
            and set(value) == {"Operation", "Strings", "AutoStart"}
            and isinstance(value["Operation"], str)
            and re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", value["Operation"]) is not None
            and type(value["AutoStart"]) is int
            and value["AutoStart"] in (0, 1)
            and isinstance(value["Strings"], dict)
            and set(value["Strings"]) == KEYS
            and all(
                isinstance(v, str) and len(v.encode("utf-8")) < 1024 and "\0" not in v
                for v in value["Strings"].values()
            )
        )

    result = json.loads(rows[0], object_pairs_hook=unique)
    if (
        not isinstance(result, dict)
        or set(result) != {"schema", "operation", "phase", "current", "receipt"}
        or result["schema"] != "samshush-home-routing-v1"
        or not isinstance(result["operation"], str)
        or result["operation"] not in {"query", "apply", "status", "restore"}
        or not state(result["current"])
    ):
        raise ValueError("Invalid routing evidence")
    receipt = result["receipt"]
    if receipt is None:
        if result["phase"] != "absent" or result["operation"] not in {
            "query",
            "status",
        }:
            raise ValueError("Missing Home recovery receipt")
    else:
        if (
            not isinstance(receipt, dict)
            or set(receipt)
            != {"Version", "Build", "Package", "App", "Phase", "Original"}
            or type(receipt["Version"]) is not int
            or receipt["Version"] != 1
            or receipt["Build"] != build
            or not isinstance(receipt["Phase"], str)
            or receipt["Phase"] not in PHASES
            or receipt["Phase"] != result["phase"]
            or not state(receipt["Original"])
            or receipt["Original"]["Operation"] != "com.samsung.tv.csfs"
            or receipt["Original"]["Strings"][HOME_KEY] != "com.samsung.tv.csfs"
        ):
            raise ValueError("Invalid Home recovery receipt")
        validate_identity(receipt["Package"], receipt["App"])
        if result["operation"] in {"apply", "restore", "status"}:
            allowed = {
                "apply": {"applied"},
                "restore": {"restored"},
                "status": {"applied", "restored", "rolled-back"},
            }
            if result["phase"] not in allowed[result["operation"]]:
                raise ValueError("Incomplete Home transaction")
            expected = receipt["Original"]
            if result["phase"] == "applied":
                expected = expected | {
                    "Operation": receipt["App"],
                    "Strings": expected["Strings"] | {HOME_KEY: receipt["App"]},
                }
            if result["current"] != expected:
                raise ValueError("Home routing readback differs from receipt")
    return result


SCRIPT = r"""set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
export LC_ALL=C
umask 077
[[ $(id -u) == 0 ]]
grep -Fxq BUILD_ID=@@BUILD@@ /etc/os-release
sha256sum -c <<'ROUTING_HASHES'
@@HASHES@@
ROUTING_HASHES
lock=/run/frame-runtime-v1.lock
state=@@JOURNAL@@
stage=''
mkdir -m 700 "$lock" || { echo 'Another operation may be running' >&2; exit 1; }
cleanup() {
 result=$?
 trap - EXIT
 if [[ -n $stage ]]; then
  for path in /proc/[0-9]*/cmdline; do
   [[ -r $path ]] || continue
   while IFS= read -r -d '' arg; do
    if [[ $arg == "$stage/LaunchpadRouting.dll" ]]; then
     echo 'Helper remains; retaining stage and operation lock' >&2; exit 1
    fi
   done < "$path" || true
  done
  rm -f "$stage/LaunchpadRouting.dll" "$stage/LaunchpadRouting.runtimeconfig.json"
  rmdir "$stage" || result=1
 fi
 rmdir "$lock" || result=1
 [[ ! -e $lock && ( -z $stage || ! -e $stage ) ]] && echo LAUNCHPAD_ROUTING_CLEANED
 exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
count=0
for path in /proc/[0-9]*/exe; do
 if [[ $(readlink "$path" 2>/dev/null || true) == /usr/bin/tvctx-manager ]]; then
  awk '/^Uid:/ {found=1; if ($2!=0 || $3!=0) bad=1} END {exit (!found || bad)}' "${path%/exe}/status"
  count=$((count+1))
 fi
done
[[ $count == 1 ]] || { echo 'Unexpected Home-routing process identity' >&2; exit 1; }
if [[ -e $state || -L $state ]]; then
 [[ -d $state && ! -L $state && $(stat -c '%u:%a' "$state") == 0:700 ]]
 shopt -s nullglob dotglob
 for path in "$state"/*; do
  [[ ( ${path##*/} == state.json || ${path##*/} == state.json.tmp ) && -f $path && ! -L $path && $(stat -c '%u:%a' "$path") == 0:600 && $(stat -c %s "$path") -le 16384 ]]
 done
 [[ -s $state/state.json || -s $state/state.json.tmp ]]
fi
@@REGISTRATION@@
stage=$(mktemp -d /run/frame-home-routing.XXXXXXXX)
@@STAGING@@
/usr/bin/dotnet "$stage/LaunchpadRouting.dll" @@ARGS@@
"""


SOURCE = r"""using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;

internal static class LaunchpadRouting
{
    const string Build = "T-NKLDUABC-0090-REL-202603190159";
    const string Root = "/opt/usr/share/samshush-home-v1";
    const string MainOperation = "http://tizen.org/appcontrol/operation/main";
    const string HomeKey = "db/appfw/home_appid";
    const string AutoKey = "db/menu/smart_hub/ontvsetting/auto_start";
    static readonly string[] Keys = { HomeKey, "db/appfw/overlay_home_appid",
        "db/appfw/startup_appid", "db/appfw/booting_appid_backup", "db/first_screen/type" };
    [DllImport("libbundle.so.0")] static extern IntPtr bundle_create();
    [DllImport("libbundle.so.0")] static extern void bundle_free(IntPtr b);
    [DllImport("libaul.so.0")] static extern int aul_svc_set_operation(IntPtr b, string op);
    [DllImport("libaul.so.0")] static extern int aul_get_default_app(IntPtr b, out IntPtr app);
    [DllImport("/usr/lib/libcapi-appfw-app-operation-tv.so.0.1.0")]
    static extern int app_operation_set_current_app(string op, string app);
    [DllImport("libvconf.so.0")] static extern IntPtr vconf_get_str(string key);
    [DllImport("libvconf.so.0")] static extern int vconf_get_int(string key, out int value);
    [DllImport("libvconf.so.0")] static extern int vconf_set_str(string key, string value);
    [DllImport("libc")] static extern uint getuid();
    [DllImport("libc")] static extern uint geteuid();
    [DllImport("libc")] static extern void free(IntPtr p);
    [DllImport("libc", SetLastError=true)] static extern int open(string path, int flags);
    [DllImport("libc", SetLastError=true)] static extern int fsync(int fd);
    [DllImport("libc", SetLastError=true)] static extern int close(int fd);
    public record State(string Operation, Dictionary<string, string> Strings, int AutoStart);
    public record Receipt(int Version, string Build, string Package, string App,
        string Phase, State Original);

    static void Require(bool value, string message) { if (!value) throw new Exception(message); }
    static string Copy(IntPtr p)
    {
        Require(p != IntPtr.Zero, "Missing typed native value");
        try {
            var bytes = new List<byte>();
            for (int i = 0; i < 1024; i++) {
                byte b = Marshal.ReadByte(p, i);
                if (b == 0) return new UTF8Encoding(false, true).GetString(bytes.ToArray());
                bytes.Add(b);
            }
            throw new Exception("Native value exceeds bound");
        } finally { free(p); }
    }
    static State Read()
    {
        IntPtr b = bundle_create();
        Require(b != IntPtr.Zero, "Cannot allocate query bundle");
        string app;
        try {
            Require(aul_svc_set_operation(b, MainOperation) == 0, "Cannot prepare query");
            IntPtr p = IntPtr.Zero;
            int rc = aul_get_default_app(b, out p);
            if (rc != 0) { if (p != IntPtr.Zero) free(p); throw new Exception("Home query failed: " + rc); }
            app = Copy(p);
        } finally { bundle_free(b); }
        Require(app.Length > 0, "No current Home handler");
        var values = Keys.ToDictionary(k => k, k => Copy(vconf_get_str(k)));
        Require(vconf_get_int(AutoKey, out int automatic) == 0, "Missing typed Auto Start");
        var state = new State(app, values, automatic);
        Require(ValidState(state), "Invalid typed Home state");
        return state;
    }
    public static bool ValidState(State? state) => state != null &&
        state.Operation != null && Regex.IsMatch(state.Operation, @"^[A-Za-z0-9_.-]{1,128}$") &&
        state.AutoStart is 0 or 1 && state.Strings != null &&
        state.Strings.Count == Keys.Length && Keys.All(state.Strings.ContainsKey) &&
        state.Strings.Values.All(v => v != null && !v.Contains('\0') && Encoding.UTF8.GetByteCount(v) < 1024);
    public static bool Equal(State a, State b) => a.Operation == b.Operation &&
        a.AutoStart == b.AutoStart && a.Strings.Count == b.Strings.Count &&
        a.Strings.All(x => b.Strings.TryGetValue(x.Key, out string? v) && v == x.Value);
    public static State Target(State original, string app) {
        var values = new Dictionary<string, string>(original.Strings); values[HomeKey] = app;
        return new State(app, values, original.AutoStart);
    }
    public static bool Known(State current, State a, State b) =>
        (current.Operation == a.Operation || current.Operation == b.Operation) &&
        (current.Strings[HomeKey] == a.Strings[HomeKey] || current.Strings[HomeKey] == b.Strings[HomeKey]) &&
        Equal(current with { Operation = a.Operation, Strings = new Dictionary<string, string>(current.Strings)
            { [HomeKey] = a.Strings[HomeKey] } }, a);

    // Journal ownership, exact registration and native-library hashes are checked by the wrapper.
    public static void Change(State before, State after, Func<State> read,
        Action<string> operation, Action<string> home, Action<string> phase, bool restoring)
    {
        Require(ValidState(before) && ValidState(after), "Invalid transaction state");
        Require(Equal(read(), before), "Home changed before mutation");
        phase(restoring ? "restoring" : "applying");
        void Write(State destination) {
            var current = read();
            Require(Known(current, before, after), "Unrelated Home drift; refusing overwrite");
            if (current.Operation != destination.Operation) operation(destination.Operation);
            current = read();
            Require(Known(current, before, after), "Unrelated Home drift after operation write");
            Require(current.Operation == destination.Operation, "Home operation readback failed");
            if (current.Strings[HomeKey] != destination.Strings[HomeKey]) home(destination.Strings[HomeKey]);
            Require(Equal(read(), destination), "Home readback differs from requested state");
        }
        try {
            Write(after);
            phase(restoring ? "restored" : "applied");
        } catch (Exception error) {
            string journalError = "";
            try {
                var current = read();
                Require(Known(current, before, after), "Unrelated Home drift; refusing rollback overwrite");
                // The durable original remains authoritative if a later phase write fails.
                // Do not let a full filesystem prevent inverse native writes.
                try { phase("rolling-back"); }
                catch (Exception marker) { journalError = "; rollback phase not saved: " + marker.Message; }
                Write(before);
                phase(restoring ? "restore-failed" : "rolled-back");
            } catch (Exception recovery) {
                try { phase("recovery-needed"); }
                catch (Exception marker) { journalError += "; recovery phase not saved: " + marker.Message; }
                throw new Exception(error.Message + "; recovery retained: " + recovery.Message + journalError);
            }
            if (journalError.Length > 0) throw new Exception(error.Message + "; rollback verified" + journalError);
            throw;
        }
    }
    static void SyncDirectory(string directory)
    {
        int fd = open(directory, 0);
        Require(fd >= 0, "Cannot open journal directory for sync");
        try { Require(fsync(fd) == 0, "Cannot sync journal directory"); }
        finally { Require(close(fd) == 0, "Cannot close journal directory"); }
    }
    public static void WriteReceipt(string directory, Receipt receipt, Action<string> sync)
    {
        Require(ValidReceipt(receipt), "Invalid recovery receipt");
        // A previous interrupted .tmp is nonauthoritative when state.json exists.
        // Its ownership/type/size are checked before this helper is started.
        using (var file = new FileStream(directory + "/state.json.tmp", FileMode.Create, FileAccess.Write)) {
            JsonSerializer.Serialize(file, receipt); file.Flush(true);
        }
        File.Move(directory + "/state.json.tmp", directory + "/state.json", true);
        sync(directory);
    }
    static void Save(Receipt receipt) => WriteReceipt(Root, receipt, SyncDirectory);
    static bool ValidIdentity(string package, string app) =>
        Regex.IsMatch(package, "^[A-Za-z0-9]{10}$") &&
        Regex.IsMatch(app, "^" + package + @"\.[A-Za-z][A-Za-z0-9_.-]{0,51}$");
    public static bool ValidReceipt(Receipt? receipt) => receipt != null &&
        receipt.Version == 1 && receipt.Build == Build &&
        receipt.Package != null && receipt.App != null && ValidIdentity(receipt.Package, receipt.App) &&
        new[] { "prepared", "applying", "applied", "restoring", "restored", "rolling-back", "rolled-back", "restore-failed", "recovery-needed" }.Contains(receipt.Phase) &&
        ValidState(receipt.Original) && receipt.Original.Operation == "com.samsung.tv.csfs" &&
        receipt.Original.Strings[HomeKey] == "com.samsung.tv.csfs";
    public static Receipt ReadReceipt(string directory)
    {
        bool committed = File.Exists(directory + "/state.json");
        string path = directory + (committed ? "/state.json" : "/state.json.tmp");
        using var document = JsonDocument.Parse(File.ReadAllText(path));
        void Unique(JsonElement element) {
            if (element.ValueKind != JsonValueKind.Object) return;
            var names = new HashSet<string>();
            foreach (var item in element.EnumerateObject()) {
                Require(names.Add(item.Name), "Duplicate recovery property"); Unique(item.Value);
            }
        }
        Unique(document.RootElement);
        void Fields(JsonElement element, string[] expected) {
            Require(element.ValueKind == JsonValueKind.Object &&
                element.EnumerateObject().Select(p => p.Name).ToHashSet().SetEquals(expected),
                "Unexpected recovery fields");
        }
        Fields(document.RootElement, new[] { "Version", "Build", "Package", "App", "Phase", "Original" });
        Fields(document.RootElement.GetProperty("Original"), new[] { "Operation", "Strings", "AutoStart" });
        var receipt = document.RootElement.Deserialize<Receipt>();
        Require(ValidReceipt(receipt), "Invalid recovery journal");
        // Before the first rename, only the original prepared receipt can exist.
        Require(committed || receipt!.Phase == "prepared", "Uncommitted recovery journal");
        return receipt!;
    }
    static int Main(string[] args)
    {
        using var deadline = new Timer(_ => Environment.Exit(124), null, 30000, Timeout.Infinite);
        try {
            Require(args.Length == 3 && new[] { "query", "apply", "status", "restore" }.Contains(args[0]), "Unknown operation");
            Require(getuid() == 0 && geteuid() == 0 && IntPtr.Size == 4, "Expected ARM32 root identity");
            Require(File.ReadAllLines("/etc/os-release").Contains("BUILD_ID=" + Build), "Unexpected build");
            State current = Read(); Receipt? receipt = null;
            if (Directory.Exists(Root)) {
                receipt = ReadReceipt(Root);
            }
            if (args[0] == "apply") {
                Require(receipt == null && !Directory.Exists(Root), "Home journal already exists; inspect or restore it");
                Require(ValidIdentity(args[1], args[2]), "Invalid target identity");
                Require(current.Operation == "com.samsung.tv.csfs" && current.Strings[HomeKey] == "com.samsung.tv.csfs", "Home is already customized");
                Directory.CreateDirectory(Root);
                receipt = new Receipt(1, Build, args[1], args[2], "prepared", current); Save(receipt);
                SyncDirectory(Path.GetDirectoryName(Root)!);
            }
            if (args[0] == "apply" || args[0] == "restore") {
                Require(receipt != null, "No Home journal");
                var target = Target(receipt!.Original, receipt.App);
                Require(Known(current, receipt.Original, target), "Home drift; refusing overwrite");
                Change(current, args[0] == "apply" ? target : receipt.Original, Read,
                    app => Require(app_operation_set_current_app(MainOperation, app) == 0, "Native Home setter failed"),
                    app => Require(vconf_set_str(HomeKey, app) == 0, "Home app setting failed"),
                    phase => { receipt = receipt with { Phase = phase }; Save(receipt); }, args[0] == "restore");
                current = Read();
            }
            if (args[0] == "status" && receipt != null) {
                Require(receipt.Phase is "applied" or "restored" or "rolled-back", "Home transaction is incomplete");
                Require(Equal(current, receipt.Phase == "applied" ? Target(receipt.Original, receipt.App) : receipt.Original), "Home state has drifted");
            }
            Console.WriteLine("LAUNCHPAD_ROUTING_JSON=" + JsonSerializer.Serialize(new {
                schema = "samshush-home-routing-v1", operation = args[0], phase = receipt?.Phase ?? "absent", current, receipt }));
            return 0;
        } catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
    }
}
"""
