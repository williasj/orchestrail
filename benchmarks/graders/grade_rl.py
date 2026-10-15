# -*- coding: utf-8 -*-
"""Independent grader for the rate-limiter benchmark.
Usage: python3 grade_rl.py impl.py <LimiterClass> <TokenBucketClass> <SlidingWindowClass>
Strategies are built as TB(capacity, refill_rate) and SW(window_size, max_requests);
the limiter as Limiter(strategy)."""
import contextlib, importlib.util, inspect, io, re, sys, threading
path, L, TB, SW = sys.argv[1:5]
spec = importlib.util.spec_from_file_location('impl', path); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
Limiter, TBucket, SWin = getattr(m, L), getattr(m, TB), getattr(m, SW)
src = open(path, encoding='utf-8').read()
score = []
def chk(name, ok):
    score.append((name, bool(ok)))
    if not ok: print('FAIL', name)

class Clock:
    def __init__(self): self.t = 1000.0
    def __call__(self): return self.t
def make(strategy, clock=None):
    try: return Limiter(strategy, clock=clock) if clock else Limiter(strategy)
    except TypeError: return Limiter(strategy)

# time-based semantics: injected clock when the limiter accepts one, else real time
import time as _time
def clock_supported():
    try: Limiter(TBucket(1, 1.0), clock=Clock()); return True
    except TypeError: return False
FAKE = clock_supported()
print('clock injection:', FAKE)
def scenario(strategy, scale):
    c = Clock()
    lim = Limiter(strategy, clock=c) if FAKE else Limiter(strategy)
    def advance(sec):
        if FAKE: c.t += sec
        else: _time.sleep(sec * scale)
    return lim, advance
s_ = 1.0 if FAKE else 0.1          # real time: compress 1 s to 0.1 s via faster rates / shorter windows
tb, adv = scenario(TBucket(5, 1.0 / s_), s_)
first = [tb.allow('a') for _ in range(7)]
chk('token bucket: burst of capacity then deny', first == [True] * 5 + [False] * 2)
adv(2.0 + (0 if FAKE else 0.05))
chk('token bucket: refills at rate', [tb.allow('a') for _ in range(3)] == [True, True, False])
chk('token bucket: clients independent', tb.allow('b'))
sw, adv = scenario(SWin(10.0 * s_, 3), s_)
chk('sliding window: max per window', [sw.allow('a') for _ in range(4)] == [True, True, True, False])
adv(10.5)
chk('sliding window: frees after window', sw.allow('a'))
# concurrency: exact limits under contention (real clock, negligible refill)
def hammer(limiter, threads=40, per=25):
    allowed = []; lock = threading.Lock(); bar = threading.Barrier(threads)
    def w():
        bar.wait(); n = 0
        for _ in range(per):
            if limiter.allow('shared'): n += 1
        with lock: allowed.append(n)
    ts = [threading.Thread(target=w) for _ in range(threads)]
    [t.start() for t in ts]; [t.join() for t in ts]
    return sum(allowed)
chk('thread-safe token bucket: exactly capacity allowed', hammer(make(TBucket(50, 0.0001))) == 50)
chk('thread-safe sliding window: exactly max allowed', hammer(make(SWin(1000.0, 37))) == 37)
# strategy pattern: no branching on algorithm type inside the limiter
mm = re.search(r'^class ' + L + r'\b.*?(?=^\S)', src + '\nEND', re.S | re.M)
lsrc = mm.group(0) if mm else ''
chk('strategy pattern (no type branching in limiter)', not re.search(r'if .*(isinstance\(.*(Bucket|Window)|algorithm|==\s*[\'"](token|sliding))', lsrc, re.I))
def _try(f):
    try: f(); return False
    except (ValueError, TypeError): return True
chk('invalid capacity rejected', _try(lambda: TBucket(0, 1)))
chk('invalid window rejected', _try(lambda: SWin(0, 1)))
# simulation harness
buf = io.StringIO()
with contextlib.redirect_stdout(buf): exec(compile(src, 'impl', 'exec'), {'__name__': '__main__'})
out = buf.getvalue()
decisions = len(re.findall(r'\b(allow(ed)?|den(y|ied)|ALLOW(ED)?|DEN(Y|IED)|True|False)\b', out))
chk('simulation logs >= 20 decisions', decisions >= 20)
chk('simulation uses >= 2 client ids', len(set(re.findall(r'client(?:_id)?\s*[=:]?\s*[\'"]?([\w-]+)', out, re.I))) >= 2)
chk('simulation mixes both algorithms', re.search(r'token', out, re.I) and re.search(r'sliding|window', out, re.I))
print(f'SCORE {sum(o for _, o in score)}/{len(score)}')
