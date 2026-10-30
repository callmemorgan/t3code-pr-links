import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("installer", Path(__file__).resolve().parents[1] / "scripts/install.py")
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)


class InstallTests(unittest.TestCase):
    def test_uninstall_removes_current_and_legacy_helpers(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            registration, installed, legacy = root / "registration", root / "installed", root / "legacy"
            for folder in (registration, installed, legacy):
                folder.mkdir()
            (registration / f"{installer.NAME}.json").write_text("{}")
            (registration / f"{installer.LEGACY_NAME}.json").write_text("{}")
            (registration / "other.host.json").write_text("{}")
            (installed / "config.json").write_text("{}")
            with patch.object(installer, "locations", return_value=(registration, installed, legacy)), patch.object(installer.sys, "argv", ["install.py", "--uninstall"]), patch("builtins.print"):
                installer.main()
            self.assertEqual([path.name for path in registration.iterdir()], ["other.host.json"])
            self.assertFalse(installed.exists() or legacy.exists())

    def test_running_without_uninstall_installs_nothing(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            registration, installed, legacy = root / "registration", root / "installed", root / "legacy"
            with patch.object(installer, "locations", return_value=(registration, installed, legacy)), patch.object(installer.sys, "argv", ["install.py"]), patch("sys.stderr"):
                with self.assertRaises(SystemExit):
                    installer.main()
            self.assertFalse(registration.exists() or installed.exists() or legacy.exists())
