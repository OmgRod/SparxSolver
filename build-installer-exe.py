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
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
INSTALLER_SCRIPT = os.path.join(ROOT, "installer", "installer.py")
DIST_DIR = os.path.join(ROOT, "installer", "dist")
BUILD_DIR = os.path.join(ROOT, "installer", "build")

def main():
    print("Checking PyInstaller...")
    if not shutil.which("pyinstaller"):
        print("Installing PyInstaller via pip...")
        subprocess.run([sys.executable, "-m", "pip", "install", "pyinstaller", "--break-system-packages"], check=True)

    print("Fetching portable Node.js binary for installer packaging...")
    bin_pack_dir = os.path.join(ROOT, "installer", "bundled_bin")
    os.makedirs(bin_pack_dir, exist_ok=True)

    # Node.js binary download helper for build platform
    node_ver = "22.17.0"
    plat_str = sys.platform
    if "win32" in plat_str:
        node_url = f"https://nodejs.org/dist/v{node_ver}/node-v{node_ver}-win-x64.zip"
        node_zip = os.path.join(bin_pack_dir, "node.zip")
        if not os.path.exists(os.path.join(bin_pack_dir, "node")):
            if not os.path.exists(node_zip):
                print(f"Downloading Node.js binary ({node_url})...")
                urllib.request.urlretrieve(node_url, node_zip)
            import zipfile
            with zipfile.ZipFile(node_zip) as z:
                z.extractall(bin_pack_dir)
            extracted_dir = os.path.join(bin_pack_dir, f"node-v{node_ver}-win-x64")
            target_node = os.path.join(bin_pack_dir, "node")
            if os.path.exists(target_node): shutil.rmtree(target_node)
            os.rename(extracted_dir, target_node)
            if os.path.exists(node_zip): os.remove(node_zip)
    else:
        node_url = f"https://nodejs.org/dist/v{node_ver}/node-v{node_ver}-linux-x64.tar.gz" if "linux" in plat_str else f"https://nodejs.org/dist/v{node_ver}/node-v{node_ver}-darwin-arm64.tar.gz"
        node_tar = os.path.join(bin_pack_dir, "node.tar.gz")
        target_node = os.path.join(bin_pack_dir, "node")
        if not os.path.exists(target_node):
            if not os.path.exists(node_tar):
                print(f"Downloading Node.js binary ({node_url})...")
                urllib.request.urlretrieve(node_url, node_tar)
            import tarfile
            with tarfile.open(node_tar) as t:
                t.extractall(bin_pack_dir)
            extracted_name = f"node-v{node_ver}-linux-x64" if "linux" in plat_str else f"node-v{node_ver}-darwin-arm64"
            extracted_dir = os.path.join(bin_pack_dir, extracted_name)
            if os.path.exists(target_node): shutil.rmtree(target_node)
            os.rename(extracted_dir, target_node)
            if os.path.exists(node_tar): os.remove(node_tar)

    print("Building standalone executable with bundled codebase and binaries...")
    cmd = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--onefile",
        "--name", "SparxSolver-Installer",
        "--distpath", DIST_DIR,
        "--workpath", BUILD_DIR,
        "--specpath", os.path.join(ROOT, "installer"),
        "--add-data", f"{os.path.join(ROOT, 'package.json')}{os.pathsep}.",
        "--add-data", f"{os.path.join(ROOT, 'browsers.json')}{os.pathsep}.",
        "--add-data", f"{os.path.join(ROOT, 'playwright.config.ts')}{os.pathsep}.",
        "--add-data", f"{os.path.join(ROOT, 'tsconfig.json')}{os.pathsep}.",
        "--add-data", f"{os.path.join(ROOT, 'src')}{os.pathsep}src",
        "--add-data", f"{os.path.join(ROOT, 'server')}{os.pathsep}server",
        "--add-data", f"{os.path.join(ROOT, 'extension')}{os.pathsep}extension",
        "--add-data", f"{bin_pack_dir}{os.pathsep}bundled_bin",
        INSTALLER_SCRIPT
    ]
    subprocess.run(cmd, check=True)

    print("\n[+] Build complete!")
    print(f"Executable output directory: {DIST_DIR}")
    if os.path.exists(DIST_DIR):
        for f in os.listdir(DIST_DIR):
            print(f"  -> {os.path.join(DIST_DIR, f)}")

if __name__ == "__main__":
    main()
