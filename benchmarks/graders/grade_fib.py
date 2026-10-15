# -*- coding: utf-8 -*-
"""Independent grader for the Fibonacci benchmark. Usage: python3 grade_fib.py impl.py"""
import contextlib, importlib.util, inspect, io, sys, warnings
path = sys.argv[1]
spec = importlib.util.spec_from_file_location('impl', path); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
score = []
def chk(name, ok):
    score.append((name, bool(ok)))
    if not ok: print('FAIL', name)
f, g = m.fibonacci, m.generate_sequence
ref = [0, 1]
for _ in range(3000): ref.append(ref[-1] + ref[-2])
chk('F(0..30) correct', all(f(i) == ref[i] for i in range(31)))
memo = {}; f(30, memo); chk('external memo populated', len(memo) >= 25)
memo2 = {}; f(50, memo2); n = len(memo2); f(40, memo2); chk('memo reused across calls', len(memo2) == n)
sig = inspect.signature(f); chk('signature fibonacci(n, memo=None)', list(sig.parameters) == ['n', 'memo'] and sig.parameters['memo'].default is None)
chk('generate_sequence(20)', g(20) == ref[:20]); chk('generate_sequence(0) == []', g(0) == [])
for bad in (-1, 2.5, '5', None, True, False):
    for fn in (f, g):
        try: fn(bad); ok = False
        except ValueError as e: ok = len(str(e)) > 10
        except Exception: ok = False
        chk(f'{fn.__name__}({bad!r}) raises ValueError', ok)
big = sys.getrecursionlimit() + 50
with warnings.catch_warnings(record=True) as w:
    warnings.simplefilter('always')
    try: r = f(big)
    except Exception as e: r = e
chk('warning above recursion limit', len(w) > 0)
chk('n above recursion limit still correct (no crash)', r == ref[big])
with warnings.catch_warnings(record=True) as w:
    warnings.simplefilter('always'); f(100)
chk('no warning for small n', len(w) == 0)
chk('docstrings', bool(f.__doc__) and bool(g.__doc__))
buf = io.StringIO()
with contextlib.redirect_stdout(buf): exec(compile(open(path).read(), 'impl', 'exec'), {'__name__': '__main__'})
chk('__main__ prints first 20', all(str(x) in buf.getvalue() for x in ref[:20]))
print(f'SCORE {sum(o for _, o in score)}/{len(score)}')
