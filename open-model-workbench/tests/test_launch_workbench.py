import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path


SKILL_DIR = Path(__file__).resolve().parents[1]
LAUNCHER = SKILL_DIR / "scripts" / "launch_workbench.py"


class LaunchWorkbenchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.server_pid: int | None = None

    def tearDown(self) -> None:
        if self.server_pid:
            try:
                os.kill(self.server_pid, signal.SIGTERM)
            except OSError:
                pass
            time.sleep(0.15)
        self.temp_dir.cleanup()

    def test_launcher_accepts_a_model_file_and_keeps_server_alive(self) -> None:
        model = self.root / "product.glb"
        model.write_bytes(b"glTF-placeholder")
        output = self.root / "workbench"

        result = subprocess.run(
            [
                sys.executable,
                str(LAUNCHER),
                str(model),
                "--output",
                str(output),
                "--no-open",
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
            timeout=20,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        state = json.loads((output / ".model-workbench-server.json").read_text(encoding="utf-8"))
        self.server_pid = int(state["pid"])
        self.assertIn(f"WORKBENCH_URL={state['url']}", result.stdout)
        for _ in range(3):
            with urllib.request.urlopen(state["url"], timeout=3) as response:
                self.assertEqual(response.status, 200)
            time.sleep(0.2)

        repeated = subprocess.run(
            [
                sys.executable,
                str(LAUNCHER),
                str(model),
                "--output",
                str(output),
                "--no-open",
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
            timeout=20,
        )
        self.assertEqual(repeated.returncode, 0, repeated.stderr)
        repeated_state = json.loads(
            (output / ".model-workbench-server.json").read_text(encoding="utf-8")
        )
        self.assertEqual(repeated_state["pid"], self.server_pid)


if __name__ == "__main__":
    unittest.main()
