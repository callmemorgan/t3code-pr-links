#!/usr/bin/env python3
"""Remove the native messaging helper installed by T3Code PR Links 1.x."""
import argparse
import shutil
import sys
from pathlib import Path

NAME = "com.callmemorgan.t3code_pr_links"
# Versions before 1.5.3 registered this name and installed to the legacy folders below.
LEGACY_NAME = "codes.t3.pr_links"


def locations():
    if sys.platform == "darwin":
        support = Path.home() / "Library/Application Support"
        return support / "Google/Chrome/NativeMessagingHosts", support / "T3Code PR Links", support / "T3 PR Links"
    if sys.platform.startswith("linux"):
        share = Path.home() / ".local/share"
        return Path.home() / ".config/google-chrome/NativeMessagingHosts", share / "t3code-pr-links", share / "t3-pr-links"
    raise SystemExit("The old helper was only installed on macOS and Linux.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--uninstall", action="store_true", required=True,
                        help="Remove the old helper. Version 2 connects to T3 directly and has nothing to install.")
    parser.parse_args()
    registration, installed, legacy = locations()
    for name in (NAME, LEGACY_NAME):
        (registration / f"{name}.json").unlink(missing_ok=True)
    for folder in (installed, legacy):
        if folder.exists():
            shutil.rmtree(folder)
    print("Removed the T3Code PR Links local helper. Remove the extension in chrome://extensions separately.")


if __name__ == "__main__":
    main()
