import unittest

from noticehub.update.version_order import _ver_tuple


class VersionTupleTest(unittest.TestCase):
    """Test version tuple parsing and comparison."""
    
    def test_release_version(self):
        """Release versions should parse to numeric tuple with (1,) marker for sorting."""
        self.assertEqual(_ver_tuple("1.0.0"), (1, 0, 0, 1))
        self.assertEqual(_ver_tuple("1.1.0"), (1, 1, 0, 1))
        self.assertEqual(_ver_tuple("2.3.4"), (2, 3, 4, 1))
    
    def test_prerelease_version(self):
        """Pre-release versions sort before release (pre-release gets 0 marker, release gets 1)."""
        pre = _ver_tuple("1.0.0-beta.1")
        rel = _ver_tuple("1.0.0")
        self.assertLess(pre, rel)  # (1,0,0,0,'beta',1) < (1,0,0,1)
    
    def test_version_comparison(self):
        """Various version comparisons."""
        self.assertLess(_ver_tuple("1.0.0-beta"), _ver_tuple("1.0.0"))
        self.assertLess(_ver_tuple("1.0.0-rc.1"), _ver_tuple("1.0.0-rc.2"))
        self.assertLess(_ver_tuple("1.0.0"), _ver_tuple("1.0.1"))
    
    def test_empty_version(self):
        """Empty or invalid versions return empty tuple."""
        self.assertEqual(_ver_tuple(""), ())
        self.assertEqual(_ver_tuple(None), ())
        self.assertEqual(_ver_tuple("invalid"), ())
