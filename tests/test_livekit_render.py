#!/usr/bin/env python3
"""Exercise the actual embedded awk renderers without running installers."""
import pathlib, re, subprocess, unittest
ROOT = pathlib.Path(__file__).resolve().parents[1]
class RenderTests(unittest.TestCase):
    def test_install_and_update_renderers(self):
        for name in ("install.sh", "update.sh"):
            source = (ROOT / name).read_text()
            program = re.search(r"-v lk_udp_end=[^\n]* '(.*?)' \"\$[^\"]+/livekit.yaml.template\"", source, re.S).group(1)
            args = ["awk", "-v", "advertise_block=", "-v", "turn_block=", "-v", "lk_udp_start=50000", "-v", "lk_udp_end=54900", program]
            result = subprocess.run(args, input="rtc:\n@ADVERTISE_INTERNAL_IP@\n  port_range_end: @LIVEKIT_UDP_PORT_RANGE_END@\n", text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, name)
            self.assertNotIn("@", result.stdout)
            self.assertIn("54900", result.stdout)
            result = subprocess.run(args, input="rtc:\n@UNRENDERED_NEW_FIELD@\n", text=True, capture_output=True)
            self.assertNotEqual(result.returncode, 0, name)
            self.assertIn("existing config preserved", result.stderr)
    def test_updater_restarts_after_updating_itself(self):
        source = (ROOT / "update.sh").read_text()
        self.assertIn('exec bash "$0" "${UPDATE_ORIGINAL_ARGS[@]}"', source)
if __name__ == "__main__":
    unittest.main()
