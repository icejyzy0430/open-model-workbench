import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SKILL_DIR = Path(__file__).resolve().parents[1]
GENERATOR = SKILL_DIR / "scripts" / "generate_workbench.py"


class GenerateWorkbenchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def run_generator(self, input_dir: Path, output_dir: Path) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, str(GENERATOR), str(input_dir), str(output_dir)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )

    def write_config(self, input_dir: Path, config: dict) -> None:
        input_dir.mkdir(parents=True, exist_ok=True)
        (input_dir / "composer.json").write_text(
            json.dumps(config, ensure_ascii=False), encoding="utf-8"
        )

    def read_generated_config(self, output_dir: Path) -> dict:
        source = (output_dir / "composer-config.js").read_text(encoding="utf-8")
        return json.loads(
            source.removeprefix("window.MODEL_WORKBENCH_CONFIG = ").removesuffix(";\n")
        )

    def test_discovers_models_and_generates_offline_workspace(self) -> None:
        input_dir = self.root / "input"
        input_dir.mkdir()
        (input_dir / "first.glb").write_bytes(b"glTF-placeholder")
        (input_dir / "second.glb").write_bytes(b"glTF-placeholder")
        output_dir = self.root / "output"

        result = self.run_generator(input_dir, output_dir)

        self.assertEqual(result.returncode, 0, result.stderr)
        generated = self.read_generated_config(output_dir)
        self.assertEqual(len(generated["models"]), 2)
        self.assertLess(generated["models"][0]["position"][0], 0)
        self.assertGreater(generated["models"][1]["position"][0], 0)
        self.assertTrue((output_dir / "vendor" / "controls" / "TransformControls.js").is_file())
        self.assertTrue((output_dir / "vendor" / "lucide.min.js").is_file())
        self.assertEqual(
            (output_dir / "assets" / "models" / "first.glb").read_bytes(),
            b"glTF-placeholder",
        )

    def test_multiple_instances_can_share_one_model_file(self) -> None:
        input_dir = self.root / "input"
        input_dir.mkdir()
        (input_dir / "product.glb").write_bytes(b"glTF-placeholder")
        self.write_config(
            input_dir,
            {
                "models": [
                    {"id": "hero", "model": "product.glb", "position": [-1, 0, 0]},
                    {"id": "support", "model": "product.glb", "position": [1, 0, 0]},
                ]
            },
        )
        output_dir = self.root / "output"

        result = self.run_generator(input_dir, output_dir)

        self.assertEqual(result.returncode, 0, result.stderr)
        generated = self.read_generated_config(output_dir)
        self.assertEqual([item["id"] for item in generated["models"]], ["hero", "support"])
        self.assertEqual(len(list((output_dir / "assets" / "models").glob("*.glb"))), 1)

    def test_gltf_dependencies_are_copied(self) -> None:
        input_dir = self.root / "input"
        textures = input_dir / "textures"
        textures.mkdir(parents=True)
        (input_dir / "mesh.bin").write_bytes(b"mesh")
        (textures / "albedo.png").write_bytes(b"image")
        (input_dir / "scene.gltf").write_text(
            json.dumps(
                {
                    "asset": {"version": "2.0"},
                    "buffers": [{"uri": "mesh.bin", "byteLength": 4}],
                    "images": [{"uri": "textures/albedo.png"}],
                }
            ),
            encoding="utf-8",
        )
        output_dir = self.root / "output"

        result = self.run_generator(input_dir, output_dir)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((output_dir / "assets" / "models" / "mesh.bin").read_bytes(), b"mesh")
        self.assertEqual(
            (output_dir / "assets" / "models" / "textures" / "albedo.png").read_bytes(),
            b"image",
        )

    def test_path_traversal_does_not_replace_output(self) -> None:
        outside = self.root / "outside.glb"
        outside.write_bytes(b"outside")
        input_dir = self.root / "input"
        self.write_config(input_dir, {"models": [{"id": "outside", "model": "../outside.glb"}]})
        output_dir = self.root / "output"
        output_dir.mkdir()
        sentinel = output_dir / "keep.txt"
        sentinel.write_text("keep", encoding="utf-8")

        result = self.run_generator(input_dir, output_dir)

        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(sentinel.read_text(encoding="utf-8"), "keep")

    def test_template_has_independent_workbench_contract(self) -> None:
        source = (SKILL_DIR / "assets" / "workbench" / "composer.js").read_text(
            encoding="utf-8"
        )
        self.assertNotIn(".innerHTML", source)
        self.assertIn("window.MODEL_WORKBENCH_CONFIG", source)
        self.assertNotIn("POINTCLOUD", source)


if __name__ == "__main__":
    unittest.main()
