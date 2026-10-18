"""Guard temporary installation boundaries and real payload identity checks."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

SPEC = importlib.util.spec_from_file_location(
    "installer_checks", Path(__file__).resolve().parents[1] / "scripts/check-windows-installers.py")
checks = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(checks)


class InstallerChecks(unittest.TestCase):
    def test_nsis_directory_is_final_and_unquoted(self):
        self.assertEqual(checks.nsis_command(r"C:\setup.exe", r"C:\install with spaces"),
                         r"C:\setup.exe /S /D=C:\install with spaces")

    def test_nsis_executable_is_quoted_separately(self):
        self.assertEqual(checks.nsis_command(r"C:\some folder\uninstall.exe"),
                         '"C:\\some folder\\uninstall.exe" /S')

    def test_nsis_rejects_argument_breakout(self):
        for suffix in ('"', '\n', '\r', '\0'):
            with self.subTest(suffix=suffix), self.assertRaises(RuntimeError):
                checks.nsis_command("setup.exe", "C:\\install" + suffix)

    def test_installed_payload_and_version(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            (directory / "player.exe").write_bytes(b"actual locally built executable")
            sha = hashlib.sha256(b"actual locally built executable").hexdigest()
            entries = [{"version": "1.2.3", "location": '"' + folder + '"'}]
            self.assertEqual(checks.installed_identity(directory, entries, "1.2.3", sha)["sha256"], sha)
            for bad in ([], entries * 2, [{"version": "1.2.2", "location": folder}],
                        [{"version": "1.2.3", "location": folder + "/elsewhere"}]):
                with self.subTest(entries=bad), self.assertRaises(RuntimeError):
                    checks.installed_identity(directory, bad, "1.2.3", sha)
            with self.assertRaises(RuntimeError):
                checks.installed_identity(directory, entries, "1.2.3", "0" * 64)

    def test_full_per_format_references_match_the_reviewed_forward_transform(self):
        raw = b"MZheader" + checks.BUNDLE_MARKER + b"unchanged payload"
        refs = checks.payload_references(raw, "2.12.3")
        self.assertEqual(refs["raw_sha256"], hashlib.sha256(raw).hexdigest())
        self.assertEqual(refs["marker_offset"], len(b"MZheader"))
        self.assertEqual(refs["size"], len(raw))
        for kind, marker in checks.BUNDLE_MARKERS.items():
            expected = raw.replace(checks.BUNDLE_MARKER, marker)
            self.assertEqual(refs["formats"][kind]["sha256"], hashlib.sha256(expected).hexdigest())
            self.assertNotEqual(refs["formats"][kind]["sha256"], refs["raw_sha256"])
        self.assertNotEqual(refs["formats"]["nsis"]["sha256"], refs["formats"]["msi"]["sha256"])

    def test_reference_derivation_rejects_unknown_or_ambiguous_inputs(self):
        for raw in (b"MZmissing", b"MZ" + checks.BUNDLE_MARKER * 2,
                    checks.BUNDLE_MARKER, b"MZ" + checks.BUNDLE_MARKERS["nsis"],
                    b"MZ" + checks.BUNDLE_MARKERS["msi"]):
            with self.subTest(raw=raw), self.assertRaises(RuntimeError):
                checks.payload_references(raw, "2.12.3")
        for version in ("2.12.2", "2.12.4", ""):
            with self.subTest(version=version), self.assertRaises(RuntimeError):
                checks.payload_references(b"MZ" + checks.BUNDLE_MARKER, version)

    def test_runtime_comparison_literals_remain_unchanged(self):
        table = b"".join(checks.BUNDLE_MARKERS.values())
        raw = b"MZheader" + table + b"payload" + checks.BUNDLE_MARKER + b"tail"
        refs = checks.payload_references(raw, "2.12.3")
        for kind, marker in checks.BUNDLE_MARKERS.items():
            expected = b"MZheader" + table + b"payload" + marker + b"tail"
            self.assertEqual(refs["formats"][kind]["sha256"], hashlib.sha256(expected).hexdigest())
        self.assertEqual(refs["marker_offset"], raw.index(checks.BUNDLE_MARKER))

    def test_reference_failure_retains_actual_raw_and_diagnostics(self):
        raw = b"MZ" + checks.BUNDLE_MARKERS["msi"]
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder)
            report = {"status": "failed", "installers": []}
            with self.assertRaisesRegex(RuntimeError, "Missing or ambiguous"):
                checks.retain_payload_references(output, raw, "2.12.3", "2.12.3", report)
            self.assertEqual((output / "raw-build.exe").read_bytes(), raw)
            saved = json.loads((output / "result.json").read_text())
            self.assertEqual(saved["status"], "failed")
            self.assertIn("Missing or ambiguous", saved["error"])
            self.assertEqual(saved["raw_build"]["marker_counts"], {"unknown": 0, "nsis": 0, "msi": 1})

    def test_cli_mismatch_retains_raw_and_failed_report(self):
        raw = b"MZ" + checks.BUNDLE_MARKER
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder)
            report = {"status": "failed", "installers": []}
            with self.assertRaisesRegex(RuntimeError, "differs from the lockfile"):
                checks.retain_payload_references(output, raw, "2.12.3", "2.12.2", report)
            self.assertEqual((output / "raw-build.exe").read_bytes(), raw)
            self.assertEqual(json.loads((output / "result.json").read_text())["status"], "failed")

    def test_installed_bytes_are_never_normalized_and_failed_hashes_are_recorded(self):
        raw = b"MZheader" + checks.BUNDLE_MARKER + b"whole payload"
        refs = checks.payload_references(raw, "2.12.3")
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            exe = directory / "player.exe"
            entries = [{"version": "1.2.3", "location": folder}]
            nsis = raw.replace(checks.BUNDLE_MARKER, checks.BUNDLE_MARKERS["nsis"])
            exe.write_bytes(nsis)
            checks.installed_identity(directory, entries, "1.2.3", refs["formats"]["nsis"]["sha256"])
            for candidate in (raw, raw.replace(checks.BUNDLE_MARKER, checks.BUNDLE_MARKERS["msi"]),
                              nsis[:-1] + b"X"):
                exe.write_bytes(candidate)
                observed = {}
                with self.subTest(candidate=candidate), self.assertRaises(RuntimeError):
                    checks.installed_identity(directory, entries, "1.2.3",
                                              refs["formats"]["nsis"]["sha256"], observed)
                self.assertEqual(observed, {"player.exe": hashlib.sha256(candidate).hexdigest()})

    def test_uninstall_requires_both_files_and_registration_removed(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder) / "install"
            with patch.object(checks, "registrations", return_value=[]):
                checks.wait_removed(directory, "Product", timeout=0)
                directory.mkdir()
                with self.assertRaises(RuntimeError):
                    checks.wait_removed(directory, "Product", timeout=0)
            directory.rmdir()
            with patch.object(checks, "registrations", return_value=[{"key": "still-installed"}]):
                with self.assertRaises(RuntimeError):
                    checks.wait_removed(directory, "Product", timeout=0)

    def test_refuses_non_windows_or_persistent_host(self):
        for platform, environment in (("linux", "github-hosted"), ("win32", "self-hosted")):
            with patch.object(checks.sys, "platform", platform), patch.dict(
                    checks.os.environ, {"GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": environment}):
                with self.assertRaises(RuntimeError):
                    checks.main()

    def test_failed_install_attempts_normal_cleanup_and_stays_failed(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            installer = base / "setup.exe"
            installer.write_bytes(b"installer")
            directory = base / "install"
            report = {"installers": []}
            operations = []

            def run(command, row, label):
                operations.append(label)
                if label == "nsis-install":
                    directory.mkdir()
                    (directory / "uninstall.exe").write_bytes(b"uninstaller")
                    raise RuntimeError("installation failed")

            with patch.object(checks, "run", side_effect=run), patch.object(
                    checks, "registrations", return_value=[]), patch.object(checks, "wait_removed"):
                with self.assertRaisesRegex(RuntimeError, "installation failed"):
                    checks.exercise("nsis", installer, directory, "Product", "1.2.3", "0" * 64, report, base)
            self.assertEqual(operations, ["nsis-install", "nsis-cleanup"])
            self.assertEqual(report["installers"][0]["status"], "failed")

    def test_timeout_kills_only_the_owned_process_tree(self):
        process = Mock(pid=4321)
        process.poll.return_value = None
        process.communicate.side_effect = [checks.subprocess.TimeoutExpired("installer", 1), ("log", None)]
        report = {"commands": []}
        with patch.object(checks.subprocess, "Popen", return_value=process), patch.object(
                checks.subprocess, "run", side_effect=checks.subprocess.TimeoutExpired("taskkill", 30)) as kill:
            with self.assertRaisesRegex(RuntimeError, "timed out"):
                checks.run(["installer.exe"], report, "install", timeout=1)
        self.assertEqual(kill.call_args.args[0], ["taskkill.exe", "/PID", "4321", "/T", "/F"])
        process.kill.assert_called_once()
        self.assertTrue(report["commands"][0]["timeout"])

    def test_late_cleanup_failure_cannot_become_overall_success(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            installer = base / "setup.exe"
            installer.write_bytes(b"installer")
            directory = base / "install"
            report = {"installers": []}

            def run(command, row, label):
                if label == "nsis-install":
                    directory.mkdir()
                    (directory / "uninstall.exe").write_bytes(b"uninstaller")
                    (directory / "player.exe").write_bytes(b"payload")
                if label == "nsis-cleanup":
                    raise RuntimeError("cleanup failed")

            # Simulate a late leftover appearing after wait_removed observed success.
            with patch.object(checks, "run", side_effect=run), patch.object(
                    checks, "registrations", return_value=[]), patch.object(
                    checks, "wait_removed"), patch.object(checks, "installed_identity", return_value={
                        "executable": str(directory / "player.exe"),
                        "sha256": hashlib.sha256(b"payload").hexdigest()}):
                with self.assertRaisesRegex(RuntimeError, "cleanup failed after qualification"):
                    checks.exercise("nsis", installer, directory, "Product", "1.2.3",
                                    hashlib.sha256(b"payload").hexdigest(), report, base)
            self.assertEqual(report["installers"][0]["status"], "failed")

    def test_installer_nonzero_is_not_acceptance(self):
        process = Mock(returncode=3010)
        process.communicate.return_value = ("restart requested", None)
        report = {"commands": []}
        with patch.object(checks.subprocess, "Popen", return_value=process):
            with self.assertRaisesRegex(RuntimeError, "3010"):
                checks.run(["msiexec.exe"], report, "install")
        self.assertEqual(report["commands"][0]["exit_code"], 3010)


if __name__ == "__main__":
    unittest.main()
