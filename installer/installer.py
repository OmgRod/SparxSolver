#!/usr/bin/env python3
import os
import sys
import platform
import subprocess
import shutil
import threading
import queue
import time
import tkinter as tk
from tkinter import ttk

# ── Colours ────────────────────────────────────────────────────────────────────
BG      = "#0f0f1a"
PANEL   = "#1a1a2e"
ACCENT  = "#6c63ff"
ACCENT2 = "#a78bfa"
GREEN   = "#4ade80"
RED     = "#f87171"
YELLOW  = "#fbbf24"
TEXT    = "#e2e8f0"
SUBTEXT = "#94a3b8"
BORDER  = "#2d2d4e"

# ── Config ─────────────────────────────────────────────────────────────────────
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


# ── Platform helper ────────────────────────────────────────────────────────────
def plat():
    s = platform.system().lower()
    if "windows" in s: return "windows"
    if "darwin"  in s: return "darwin"
    return "linux"

IS_WIN = plat() == "windows"


# ── Installer logic (runs in a background thread) ──────────────────────────────

class InstallerWorker:
    """
    Runs all install steps and communicates progress back via a queue.
    Queue message dicts:
      {"type": "log",          "msg": str, "colour": str}
      {"type": "step",         "text": str, "index": int, "total": int}
      {"type": "sub_progress", "value": int, "maximum": int, "text": str}
      {"type": "done",         "success": bool, "message": str}
    """

    def __init__(self, install_dir: str, msg_queue: queue.Queue):
        self.install_dir = install_dir          # SparxSolver/
        self.bin_dir     = os.path.join(install_dir, "bin")
        self.app_dir     = os.path.join(install_dir, "app")
        self.q           = msg_queue
        self._cancelled  = False

    # ── Queue helpers ──────────────────────────────────────────────────────────
    def _put(self, **kw):
        self.q.put(kw)

    def log(self, msg, colour=TEXT):
        self._put(type="log", msg=msg, colour=colour)

    def set_step(self, text, index, total):
        self._put(type="step", text=text, index=index, total=total)

    def set_sub(self, value, maximum=100, text=""):
        self._put(type="sub_progress", value=value, maximum=maximum, text=text)

    def done(self, success=True, message=""):
        self._put(type="done", success=success, message=message)

    # ── Run subprocess ─────────────────────────────────────────────────────────
    def run(self, cmd, cwd=None, env=None):
        display = " ".join(str(x) for x in cmd)
        self.log(f"  $ {display}", SUBTEXT)
        proc = subprocess.Popen(
            cmd, cwd=cwd, env=env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, shell=isinstance(cmd, str),
        )
        for line in proc.stdout:
            line = line.rstrip()
            if line:
                self.log(f"    {line}", SUBTEXT)
            if self._cancelled:
                proc.terminate()
                raise InterruptedError("cancelled")
        proc.wait()
        if proc.returncode != 0:
            raise RuntimeError(
                f"Command failed (exit {proc.returncode}): {display}")

    # ── Node helpers ───────────────────────────────────────────────────────────
    def _node_bin_dir(self, node_root):
        return node_root if IS_WIN else os.path.join(node_root, "bin")

    def _npm(self, node_root):
        return os.path.join(node_root,
                            "npm.cmd" if IS_WIN else "bin/npm")

    def _node_env(self, node_root):
        e = os.environ.copy()
        e["PATH"] = self._node_bin_dir(node_root) + os.pathsep + e.get("PATH", "")
        e["NODE_PATH"] = ""
        e["npm_config_cache"] = os.path.join(node_root, ".npm-cache")
        return e

    # ── STEP 1 — Extract bundled repo codebase ─────────────────────────────────
    def clone_repo(self, git_root):
        self.log("Extracting SparxSolver codebase…", TEXT)
        self.set_sub(0, 0, "Unpacking codebase…")
        os.makedirs(self.app_dir, exist_ok=True)

        # Base path for PyInstaller bundled temp files
        bundled_base = getattr(sys, '_MEIPASS', ROOT)

        # Copy bundled package files, src, server, extension into app_dir
        items = ["package.json", "browsers.json", "playwright.config.ts", "tsconfig.json", "src", "server", "extension"]
        for item in items:
            src_item = os.path.join(bundled_base, item)
            dst_item = os.path.join(self.app_dir, item)
            if os.path.exists(src_item):
                self.log(f"  Unpacking {item}…", SUBTEXT)
                if os.path.isdir(src_item):
                    shutil.copytree(src_item, dst_item, dirs_exist_ok=True)
                else:
                    shutil.copy2(src_item, dst_item)

        self.set_sub(100, 100, "Unpack complete ✓")
        self.log("  ✓ Repository & codebase ready (offline bundle).", GREEN)

    # ── STEP 3 — Ensure Node.js ────────────────────────────────────────────────
    def ensure_node(self):
        self.log("Checking for Node.js…", TEXT)

        node_root = os.path.join(self.bin_dir, "node")
        node_exe  = os.path.join(node_root, "node.exe" if IS_WIN else "bin/node")

        if os.path.isfile(node_exe):
            self.log("  ✓ Bundled Node.js already present.", GREEN)
            self.set_sub(100, 100, "Bundled Node.js ready")
            return node_root

        # Unpack bundled Node.js binary package
        bundled_base = getattr(sys, '_MEIPASS', ROOT)
        bundled_node = os.path.join(bundled_base, "bundled_bin", "node")

        if os.path.isdir(bundled_node):
            self.log("  Unpacking bundled Node.js binary…", SUBTEXT)
            self.set_sub(0, 0, "Unpacking Node.js…")
            shutil.copytree(bundled_node, node_root, dirs_exist_ok=True, symlinks=True)

            if not IS_WIN:
                for name in ["node", "npm", "npx", "corepack"]:
                    fp = os.path.join(node_root, "bin", name)
                    if os.path.isfile(fp) or os.path.islink(fp):
                        try: os.chmod(fp, 0o755)
                        except Exception: pass

            self.set_sub(100, 100, "Node.js unpacked ✓")
            self.log("  ✓ Bundled Node.js ready.", GREEN)
            return node_root

        if shutil.which("node"):
            self.log("  ✓ Using system Node.js.", GREEN)
            self.set_sub(100, 100, "Using system Node.js")
            return None

        raise RuntimeError("Bundled Node.js binary not found in installer package.")

    # ── STEP 4 — Clean + npm install + build + Playwright Chromium install ────
    def _clean_app(self):
        """Delete generated build cache artefacts."""
        self.log("Cleaning previous build artefacts…", TEXT)

        app = self.app_dir
        ext = os.path.join(app, "extension")

        dirs_to_remove = [
            os.path.join(app, "node_modules"),
            os.path.join(app, "dist"),
            os.path.join(app, "dist_server"),
            os.path.join(ext, "node_modules"),
            os.path.join(ext, "dist"),
        ]

        total = len(dirs_to_remove)
        done  = 0

        for d in dirs_to_remove:
            if os.path.isdir(d):
                rel = os.path.relpath(d, app)
                self.log(f"  Removing {rel}/", SUBTEXT)
                shutil.rmtree(d, ignore_errors=True)
            done += 1
            self.set_sub(done * 100 // total, 100, "Cleaning…")

        self.set_sub(100, 100, "Clean complete ✓")
        self.log("  ✓ Artefacts cleaned.", GREEN)

    def npm_install_and_build(self, node_root):
        npm = self._npm(node_root) if node_root else (shutil.which("npm") or "npm")
        npx = os.path.join(node_root, "npx.cmd" if IS_WIN else "bin/npx") if node_root else (shutil.which("npx") or "npx")
        env = self._node_env(node_root) if node_root else None
        ext = os.path.join(self.app_dir, "extension")

        self._clean_app()

        self.log("Installing root dependencies (npm i)…", TEXT)
        self.set_sub(0, 100, "npm install…")
        self.run([npm, "install"], cwd=self.app_dir, env=env)
        self.set_sub(25, 100, "Root deps done ✓")
        self.log("  ✓ Root dependencies installed.", GREEN)

        self.log("Installing extension dependencies (npm i)…", TEXT)
        self.set_sub(25, 100, "npm install (extension)…")
        self.run([npm, "install"], cwd=ext, env=env)
        self.set_sub(50, 100, "Extension deps done ✓")
        self.log("  ✓ Extension dependencies installed.", GREEN)

        self.log("Building extension (npm run build)…", TEXT)
        self.set_sub(50, 100, "Building extension…")
        self.run([npm, "run", "build"], cwd=ext, env=env)
        self.set_sub(75, 100, "Build complete ✓")
        self.log("  ✓ Extension built successfully.", GREEN)

        self.log("Installing Playwright Chromium browser binary…", TEXT)
        self.set_sub(75, 100, "Installing Playwright Chromium…")
        self.run([npx, "playwright", "install", "chromium"], cwd=self.app_dir, env=env)
        self.set_sub(100, 100, "Playwright Chromium installed ✓")
        self.log("  ✓ Playwright Chromium browser installed.", GREEN)

    # ── STEP 5 — Create launcher scripts ──────────────────────────────────────
    def create_launchers(self, node_root):
        self.log("Creating launcher scripts…", TEXT)
        app_abs = os.path.abspath(self.app_dir)

        if node_root:
            npm_abs  = os.path.abspath(self._npm(node_root))
            bdir_abs = os.path.abspath(self._node_bin_dir(node_root))
            npm_cmd_win  = f'"{npm_abs}"'
            npm_cmd_sh   = f'"{npm_abs}"'
            path_win     = f'set "PATH={bdir_abs};%PATH%"'
            path_sh      = f'export PATH="{bdir_abs}:$PATH"'
        else:
            npm_cmd_win = "npm"
            npm_cmd_sh  = "npm"
            path_win    = ""
            path_sh     = ""

        # ── start.bat ──
        bat = ["@echo off", "title SparxSolver Server"]
        if path_win:
            bat.append(path_win)
        bat += [
            f'cd /d "{app_abs}"',
            "echo Starting SparxSolver Server...",
            f"{npm_cmd_win} start",
            "pause",
        ]
        bat_path = os.path.join(self.install_dir, "start.bat")
        with open(bat_path, "w", newline="\r\n") as f:
            f.write("\n".join(bat) + "\n")
        self.log("  ✓ Created start.bat", GREEN)

        # ── start.sh ──
        sh = ["#!/usr/bin/env bash"]
        if path_sh:
            sh.append(path_sh)
        sh += [
            f'cd "{app_abs}"',
            "echo 'Starting SparxSolver Server...'",
            f"{npm_cmd_sh} start",
        ]
        sh_path = os.path.join(self.install_dir, "start.sh")
        with open(sh_path, "w", newline="\n") as f:
            f.write("\n".join(sh) + "\n")
        os.chmod(sh_path, 0o755)
        self.log("  ✓ Created start.sh", GREEN)

        self.set_sub(100, 100, "Launchers created ✓")

    # ── Main entry ─────────────────────────────────────────────────────────────
    def run_all(self):
        TOTAL = 3
        try:
            os.makedirs(self.install_dir, exist_ok=True)
            os.makedirs(self.bin_dir,     exist_ok=True)

            self.set_step("Step 1 / 3 — Unpacking codebase & Node.js", 1, TOTAL)
            self.clone_repo(None)
            node_root = self.ensure_node()

            self.set_step("Step 2 / 3 — Installing & building",      2, TOTAL)
            self.npm_install_and_build(node_root)

            self.set_step("Step 3 / 3 — Creating launcher scripts",  3, TOTAL)
            self.create_launchers(node_root)

            self.done(True)

        except InterruptedError:
            self.done(False, "Installation was cancelled.")
        except Exception as exc:
            self.log(f"\n  ✗ Error: {exc}", RED)
            self.done(False, str(exc))


# ── Tkinter GUI ────────────────────────────────────────────────────────────────

class InstallerApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("SparxSolver Installer")
        self.geometry("780x620")
        self.resizable(False, False)
        self.configure(bg=BG)

        # Install dir: SparxSolver/ next to this script/exe
        if getattr(sys, "frozen", False):
            # Running as compiled binary (PyInstaller / cx_Freeze / py2exe)
            base = os.path.dirname(sys.executable)
        else:
            # Running as raw .py script
            base = os.path.dirname(os.path.abspath(__file__))
        self.install_dir = os.path.join(base, "SparxSolver")

        self._queue = queue.Queue()
        self._build_ui()
        self._poll_queue()

    # ── UI construction ────────────────────────────────────────────────────────
    def _build_ui(self):
        # Header
        hdr = tk.Frame(self, bg=ACCENT, height=80)
        hdr.pack(fill="x")
        hdr.pack_propagate(False)
        tk.Label(hdr, text="SparxSolver", font=("Segoe UI", 22, "bold"),
                 bg=ACCENT, fg="white").pack(side="left", padx=24, pady=14)
        tk.Label(hdr, text="Installer", font=("Segoe UI", 14),
                 bg=ACCENT, fg="#c4b5fd").pack(side="left", pady=14)

        # Path info strip
        strip = tk.Frame(self, bg=PANEL, pady=10)
        strip.pack(fill="x")
        tk.Label(strip, text="  Installing to:", font=("Segoe UI", 9),
                 bg=PANEL, fg=SUBTEXT).pack(anchor="w", padx=20)
        tk.Label(strip, text=f"  {self.install_dir}",
                 font=("Consolas", 9), bg=PANEL, fg=ACCENT2).pack(anchor="w", padx=20)

        tk.Frame(self, bg=BORDER, height=1).pack(fill="x")

        # Step progress
        sf = tk.Frame(self, bg=BG, pady=14)
        sf.pack(fill="x", padx=24)
        self._step_lbl = tk.Label(sf, text="Ready to install",
                                   font=("Segoe UI", 10, "bold"),
                                   bg=BG, fg=TEXT, anchor="w")
        self._step_lbl.pack(fill="x")

        style = ttk.Style(self)
        style.theme_use("clam")
        style.configure("Step.Horizontal.TProgressbar",
                         troughcolor=PANEL, background=ACCENT,
                         borderwidth=0, thickness=16)
        style.configure("Sub.Horizontal.TProgressbar",
                         troughcolor=PANEL, background=ACCENT2,
                         borderwidth=0, thickness=10)

        self._step_bar = ttk.Progressbar(sf, style="Step.Horizontal.TProgressbar",
                                          length=730, maximum=5, value=0)
        self._step_bar.pack(fill="x", pady=(6, 0))

        # Sub-step progress
        sbf = tk.Frame(self, bg=BG, pady=4)
        sbf.pack(fill="x", padx=24)
        self._sub_lbl = tk.Label(sbf, text="", font=("Segoe UI", 8),
                                  bg=BG, fg=SUBTEXT, anchor="w")
        self._sub_lbl.pack(fill="x")
        self._sub_bar = ttk.Progressbar(sbf, style="Sub.Horizontal.TProgressbar",
                                         length=730, maximum=100, value=0)
        self._sub_bar.pack(fill="x", pady=(4, 0))

        tk.Frame(self, bg=BORDER, height=1).pack(fill="x", pady=(10, 0))

        # ── Bottom bar — packed BEFORE the log so side="bottom" is respected ──
        bot = tk.Frame(self, bg=PANEL, height=60)
        bot.pack(side="bottom", fill="x")
        bot.pack_propagate(False)
        self._status_lbl = tk.Label(bot, text="Click Install to begin.",
                                     font=("Segoe UI", 9), bg=PANEL, fg=SUBTEXT)
        self._status_lbl.pack(side="left", padx=20)
        self._close_btn = tk.Button(
            bot, text="  Close  ", font=("Segoe UI", 10),
            bg=PANEL, fg=SUBTEXT, activebackground=BORDER,
            activeforeground=TEXT, relief="flat", cursor="hand2",
            padx=16, pady=8, command=self.destroy)
        self._close_btn.pack(side="right", padx=20, pady=10)
        self._main_btn = tk.Button(
            bot, text="  Install  ", font=("Segoe UI", 10, "bold"),
            bg=ACCENT, fg="white", activebackground=ACCENT2,
            activeforeground="white", relief="flat", cursor="hand2",
            padx=16, pady=8, command=self._start_install)
        self._main_btn.pack(side="right", padx=4, pady=10)

        # Log area — packed last so expand=True fills remaining space
        lf = tk.Frame(self, bg=BG)
        lf.pack(fill="both", expand=True, padx=14, pady=(8, 0))
        self._log = tk.Text(lf, bg="#0a0a14", fg=TEXT, relief="flat",
                             font=("Consolas", 9), wrap="word",
                             state="disabled", bd=0,
                             highlightthickness=1, highlightbackground=BORDER)
        self._log.pack(side="left", fill="both", expand=True)
        sb = ttk.Scrollbar(lf, command=self._log.yview)
        sb.pack(side="right", fill="y")
        self._log["yscrollcommand"] = sb.set
        for tag, colour in [
            ("green", GREEN), ("red", RED), ("yellow", YELLOW),
            ("sub", SUBTEXT), ("accent", ACCENT2), ("text", TEXT),
        ]:
            self._log.tag_configure(tag, foreground=colour)


    # ── Log helper ─────────────────────────────────────────────────────────────
    def _log_write(self, msg: str, colour=TEXT):
        _map = {GREEN:"green", RED:"red", YELLOW:"yellow",
                SUBTEXT:"sub", ACCENT2:"accent", TEXT:"text"}
        tag = _map.get(colour, "text")
        self._log.configure(state="normal")
        self._log.insert("end", msg + "\n", tag)
        self._log.configure(state="disabled")
        self._log.see("end")

    # ── Queue poll ─────────────────────────────────────────────────────────────
    def _poll_queue(self):
        """
        Drain all pending queue messages and reschedule itself.
        IMPORTANT: self.after() is called unconditionally at the bottom so that
        no exception (TclError, AttributeError, etc.) can silently kill the loop.
        Only a 'done' message causes a clean exit.
        """
        done_received = False
        try:
            while True:
                try:
                    msg = self._queue.get_nowait()
                except queue.Empty:
                    break

                t = msg.get("type")
                try:
                    if t == "log":
                        self._log_write(msg["msg"], msg.get("colour", TEXT))

                    elif t == "step":
                        self._step_lbl.config(text=msg["text"])
                        self._step_bar.config(
                            maximum=msg["total"], value=msg["index"])

                    elif t == "sub_progress":
                        val = msg["value"]
                        mx  = msg["maximum"]
                        self._sub_lbl.config(text=msg.get("text", ""))
                        if mx == 0:
                            # Indeterminate: just leave the bar where it is and
                            # let the pulsing _pulse_sub handle animation so we
                            # avoid TclError from mode-switching.
                            self._sub_bar.config(
                                mode="determinate", maximum=100, value=0)
                        else:
                            self._sub_bar.config(
                                mode="determinate", maximum=mx, value=val)

                    elif t == "done":
                        done_received = True
                        self._on_done(msg["success"], msg.get("message", ""))

                except Exception as widget_err:
                    # Log but never let a widget error kill the polling loop
                    print(f"[poll] widget error: {widget_err}", flush=True)

        except Exception as outer_err:
            print(f"[poll] outer error: {outer_err}", flush=True)

        if not done_received:
            self.after(80, self._poll_queue)

    # ── Start install ──────────────────────────────────────────────────────────
    def _start_install(self):
        self._main_btn.config(state="disabled", bg=BORDER)
        self._status_lbl.config(text="Installing… please wait.", fg=YELLOW)
        self._log_write("━" * 60)
        self._log_write("  SparxSolver Installer — starting…")
        self._log_write(f"  Install directory: {self.install_dir}", ACCENT2)
        self._log_write("━" * 60)

        worker = InstallerWorker(self.install_dir, self._queue)
        threading.Thread(target=worker.run_all, daemon=True).start()

    # ── Done callback ──────────────────────────────────────────────────────────
    def _on_done(self, success: bool, message: str):
        self._sub_bar.stop()
        self._sub_bar.config(mode="determinate", maximum=100)

        if success:
            self._sub_bar.config(value=100)
            self._step_bar.config(value=5)
            self._step_lbl.config(text="✅  Installation complete!")
            self._sub_lbl.config(text="All done — SparxSolver is ready to run.")
            self._status_lbl.config(text="Installation complete!", fg=GREEN)
            self._log_write("")
            self._log_write("━" * 60, GREEN)
            self._log_write("  ✅  Installation complete!", GREEN)
            self._log_write("━" * 60, GREEN)
            self._log_write("")
            self._log_write("  To start SparxSolver:", TEXT)
            if IS_WIN:
                self._log_write("    → Run  start.bat  (Windows)", ACCENT2)
            self._log_write("    → Run  start.sh   (Linux / macOS)", ACCENT2)
            self._log_write(f"  Both files are in: {self.install_dir}", SUBTEXT)
            self._main_btn.config(
                text="  Launch! 🚀  ", state="normal",
                bg=GREEN, fg="#0f0f1a", command=self._launch)
        else:
            self._step_lbl.config(text="❌  Installation failed")
            self._sub_lbl.config(text=(message[:80] if message else ""))
            self._status_lbl.config(text="Installation failed. See log.", fg=RED)
            self._log_write("")
            self._log_write("━" * 60, RED)
            self._log_write("  ❌  Installation failed.", RED)
            if message:
                self._log_write(f"  {message}", RED)
            self._log_write("━" * 60, RED)
            self._main_btn.config(
                text="  Retry  ", state="normal",
                bg=YELLOW, fg="#0f0f1a", command=self._retry)

    # ── Launch / Retry ─────────────────────────────────────────────────────────
    def _launch(self):
        self._should_run_server = True
        self.destroy()

    def _retry(self):
        self._log.configure(state="normal")
        self._log.delete("1.0", "end")
        self._log.configure(state="disabled")
        self._step_bar.config(value=0)
        self._sub_bar.config(value=0)
        self._step_lbl.config(text="Ready to install")
        self._sub_lbl.config(text="")
        self._status_lbl.config(text="Click Install to begin.", fg=SUBTEXT)
        self._main_btn.config(text="  Install  ", bg=ACCENT, fg="white",
                               command=self._start_install, state="normal")
        self._poll_queue()


# ── Entry point ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    app = InstallerApp()
    app.mainloop()

    if getattr(app, '_should_run_server', False):
        print("\n" + "=" * 60)
        print("  Starting SparxSolver Server...")
        print("  Press Ctrl+C in this terminal to stop the server.")
        print("=" * 60 + "\n", flush=True)

        script_bat = os.path.join(app.install_dir, "start.bat")
        script_sh = os.path.join(app.install_dir, "start.sh")

        if IS_WIN:
            subprocess.run([script_bat], shell=True)
        else:
            subprocess.run(["bash", script_sh])
