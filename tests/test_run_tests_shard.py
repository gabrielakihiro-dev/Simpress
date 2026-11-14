import unittest

from run_tests import _select_shard


class _Case(unittest.TestCase):
    def check(self):
        pass


def _module(size: int) -> unittest.TestSuite:
    return unittest.TestSuite(_Case("check") for _ in range(size))


class SelectShardTests(unittest.TestCase):
    def test_parts_cover_every_module_once_and_stay_balanced(self):
        modules = [_module(size) for size in (5, 4, 3, 3, 2, 1)]
        suite = unittest.TestSuite(modules)
        parts = [_select_shard(suite, f"{index}/3") for index in (1, 2, 3)]
        chosen = [id(module) for part in parts for module in part]
        self.assertEqual(sorted(chosen), sorted(id(module) for module in modules))
        self.assertEqual([part.countTestCases() for part in parts], [6, 6, 6])

    def test_empty_shard_keeps_whole_suite_and_invalid_shard_is_refused(self):
        suite = unittest.TestSuite([_module(1)])
        self.assertIs(_select_shard(suite, ""), suite)
        for invalid in ("0/4", "5/4", "1"):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                _select_shard(suite, invalid)


if __name__ == "__main__":
    unittest.main()
