# -*- coding: utf-8 -*-
# Skill: python-run-tests
# Executes implementation code, then runs unittest TestCase(s) defined in
# test_code against it in the same namespace. Returns deterministic counts.
# Input: { "code": <impl source>, "test_code": <source defining unittest.TestCase> }
#
# Counting is per test METHOD, not per assertion/subTest. A method that uses
# self.subTest in a loop is one test: if any subtest fails the method counts once
# as failed. This avoids the defect where len(result.failures) (one entry per
# failed subtest) exceeded testsRun and drove passed negative.
import io
import unittest


class _CountingResult(unittest.TextTestResult):
    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self._failed_ids = set()
        self._errored_ids = set()

    def addFailure(self, test, err):
        super().addFailure(test, err)
        self._failed_ids.add(test.id())

    def addError(self, test, err):
        super().addError(test, err)
        self._errored_ids.add(test.id())

    def addSubTest(self, test, subtest, outcome):
        super().addSubTest(test, subtest, outcome)
        if outcome is not None:
            exc_type = outcome[0]
            if exc_type is not None and issubclass(exc_type, test.failureException):
                self._failed_ids.add(test.id())
            else:
                self._errored_ids.add(test.id())


def skill(input):
    if not isinstance(input, dict):
        return {"ok": False, "ran": 0, "passed": 0, "failed": 0,
                "errored": 0, "error": "input must be an object with code + test_code"}
    code = input.get("code", "")
    test_code = input.get("test_code", "")

    ns = {}
    try:
        exec(compile(code, "<impl>", "exec"), ns)
    except Exception as e:
        return {"ok": False, "ran": 0, "passed": 0, "failed": 0,
                "errored": 0, "error": "impl raised " + type(e).__name__ + ": " + str(e)}

    try:
        exec(compile(test_code, "<tests>", "exec"), ns)
    except Exception as e:
        return {"ok": False, "ran": 0, "passed": 0, "failed": 0,
                "errored": 0, "error": "test_code raised " + type(e).__name__ + ": " + str(e)}

    suite = unittest.TestSuite()
    loader = unittest.TestLoader()
    found = False
    for value in list(ns.values()):
        if isinstance(value, type) and issubclass(value, unittest.TestCase):
            suite.addTests(loader.loadTestsFromTestCase(value))
            found = True
    if not found:
        return {"ok": False, "ran": 0, "passed": 0, "failed": 0,
                "errored": 0, "error": "no unittest.TestCase subclass found in test_code"}

    runner = unittest.TextTestRunner(stream=io.StringIO(), verbosity=0,
                                     resultclass=_CountingResult)
    res = runner.run(suite)

    ran = res.testsRun
    # Distinct methods that errored, then distinct methods that failed but did
    # not also error. These sets are subsets of the run methods, so the counts
    # are always coherent and passed can never go negative.
    errored = len(res._errored_ids)
    failed = len(res._failed_ids - res._errored_ids)
    passed = ran - failed - errored
    if passed < 0:
        passed = 0
    return {"ok": failed == 0 and errored == 0 and ran > 0,
            "ran": ran, "passed": passed, "failed": failed,
            "errored": errored, "error": None}
