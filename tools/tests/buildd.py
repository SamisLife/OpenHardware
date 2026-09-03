"""Small contract checks for the loopback firmware build daemon.

Run from the repository root with ``python tools/tests/buildd.py``. These
checks do not invoke Docker or replace the application source directory.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("openhardware_buildd", ROOT / "tools" / "buildd.py")
assert SPEC and SPEC.loader
buildd = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(buildd)


class BuildDaemonContract(unittest.TestCase):
    def test_accepts_a_complete_small_application(self):
        files, error = buildd.validate_files({
            "app.c": '#include "hw_app.h"\nvoid app_setup(void) {}\nvoid app_loop(void) {}\n',
            "feature.h": "#pragma once\n",
        })
        self.assertIsNone(error)
        self.assertEqual(set(files), {"app.c", "feature.h"})

    def test_requires_app_c(self):
        files, error = buildd.validate_files({"feature.c": "void feature(void) {}\n"})
        self.assertIsNone(files)
        self.assertIn("app.c", error)

    def test_rejects_paths_and_non_source_files(self):
        for name in ("../app.c", "sub/app.c", "app.cpp", ".hidden.c"):
            with self.subTest(name=name):
                files, error = buildd.validate_files({name: "source"})
                self.assertIsNone(files)
                self.assertTrue(error)

    def test_rejects_new_i2c_driver_access(self):
        for source in (
            '#include "driver/i2c_master.h"\n',
            "i2c_new_master_bus(&cfg, &bus);\n",
            "i2c_master_transmit(dev, data, 1, 10);\n",
        ):
            with self.subTest(source=source):
                files, error = buildd.validate_files({"app.c": source})
                self.assertIsNone(files)
                self.assertIn("I2C", error)

    def test_extracts_identity_and_compiler_diagnostics(self):
        files = {"app.c": 'const hw_app_info_t app_info = { .name = "blink", .version = "2.1" };'}
        self.assertEqual(buildd.app_identity(files), ("blink", "2.1"))
        diagnostics = buildd.parse_diagnostics(
            "/build/app.c:8:3: error: use of undeclared identifier 'pin'\n"
            "collect2: error: ld returned 1 exit status\n"
            "CMake Error at /project/components/app/CMakeLists.txt:1 (file):\n\n"
            "  CONFIGURE_DEPENDS is invalid for script mode.\n"
        )
        self.assertTrue(any(item.get("file") == "/build/app.c" and item.get("line") == 8 for item in diagnostics))
        self.assertTrue(any(item.get("file", "").endswith("CMakeLists.txt") for item in diagnostics))

    def test_manifest_lists_every_source_without_script_mode_globbing(self):
        manifest = buildd.app_manifest({
            "app.c": "source",
            "frame_meter.c": "source",
            "frame_meter.h": "header",
        })
        self.assertIn('"app.c"', manifest)
        self.assertIn('"frame_meter.c"', manifest)
        self.assertNotIn('"frame_meter.h"', manifest)
        self.assertNotIn("CONFIGURE_DEPENDS", manifest)


if __name__ == "__main__":
    unittest.main(verbosity=2)
