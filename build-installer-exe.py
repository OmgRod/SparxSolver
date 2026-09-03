#!/usr/bin/env python3
"""
Build script for compiling installer/installer.py into single-file binary executables using PyInstaller.

Usage:
  python3 build-installer-exe.py

Requirements:
  pip install pyinstaller
"""

import os
import sys
import subprocess
import shutil

ROOT = os.path.dirname(os.path.abspath(__file__))
INSTALLER_SCRIPT = os.path.join(ROOT, "installer", "installer.py")
DIST_DIR = os.path.join(ROOT, "installer", "dist")
BUILD_DIR = os.path.join(ROOT, "installer", "build")

def main():
    print("Checking PyInstaller...")
    if not shutil.which("pyinstaller"):
        print("Installing PyInstaller via pip...")
        subprocess.run([sys.executable, "-m", "pip", "install", "pyinstaller", "--break-system-packages"], check=True)

    print("Building standalone executable with bundled codebase...")
    cmd = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--onefile",
        "--windowed",
        "--name", "SparxSolver-Installer",
        "--distpath", DIST_DIR,
        "--workpath", BUILD_DIR,
        "--specpath", os.path.join(ROOT, "installer"),
        "--add-data", f"{os.path.join(ROOT, 'package.json')}{os.pathsep}.",
        "--add-data", f"{os.path.join(ROOT, 'src')}{os.pathsep}src",
        "--add-data", f"{os.path.join(ROOT, 'server')}{os.pathsep}server",
        "--add-data", f"{os.path.join(ROOT, 'extension')}{os.pathsep}extension",
        INSTALLER_SCRIPT
    ]
    subprocess.run(cmd, check=True)

    print("\n✅ Build complete!")
    print(f"Executable output directory: {DIST_DIR}")
    if os.path.exists(DIST_DIR):
        for f in os.listdir(DIST_DIR):
            print(f"  → {os.path.join(DIST_DIR, f)}")

if __name__ == "__main__":
    main()
