# -*- coding: utf-8 -*-
"""Independent grader for the LRU benchmark. Usage: python3 grade_lru.py impl.py"""
import contextlib, importlib.util, io, re, sys
path = sys.argv[1]
spec = importlib.util.spec_from_file_location('impl', path); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
src = open(path, encoding='utf-8').read()
C = m.LRUCache
score = []
def chk(name, ok):
    score.append((name, bool(ok)))
    if not ok: print('FAIL', name)
MISS = (None, -1)
c = C(2); c.put('a', 1); c.put('b', 2)
chk('get hit returns value', c.get('a') == 1)
c.put('c', 3)                                   # evicts b (a was just used)
chk('evicts least recently used', c.get('b') in MISS and c.get('a') == 1 and c.get('c') == 3)
c.put('a', 10)                                  # update, makes a MRU
c.put('d', 4)                                   # evicts c
chk('update changes value', c.get('a') == 10)
chk('update refreshes recency', c.get('c') in MISS and c.get('d') == 4)
c1 = C(1); c1.put('x', 1); c1.put('y', 2)
chk('capacity 1', c1.get('x') in MISS and c1.get('y') == 2)
big = C(1000)
for i in range(5000): big.put(i, i)
chk('size never exceeds capacity', all(big.get(i) in MISS for i in range(4000)) and big.get(4999) == 4999)
def raises(f):
    try: f(); return False
    except (ValueError, TypeError): return True
chk('capacity 0 or negative rejected', raises(lambda: C(0)) and raises(lambda: C(-1)))
# O(1) structure: dict + linked list or OrderedDict, not list scans
chk('O(1) structure (OrderedDict or linked nodes)', bool(re.search(r'OrderedDict|move_to_end|class _?Node|\.prev\b', src)))
chk('no O(n) list.remove/index on hot path', not re.search(r'\.(remove|index|pop)\(\s*(?:self\.)?\w*key', src))
# operations helper: find a function/method taking a list of operations and returning per-step states
helper = None
for name in dir(m):
    obj = getattr(m, name)
    if callable(obj) and re.search(r'replay|run_op|apply|simulat|process|execute|operations', name, re.I): helper = (name, obj)
for name in dir(C):
    if re.search(r'replay|run_op|apply|simulat|process|execute|operations', name, re.I): helper = (name, getattr(C(3), name))
ok = False
if helper:
    for ops in ([('put', 'a', 1), ('put', 'b', 2), ('get', 'a'), ('put', 'c', 3), ('put', 'd', 4)],
                [{'op': 'put', 'key': 'a', 'value': 1}, {'op': 'put', 'key': 'b', 'value': 2}, {'op': 'get', 'key': 'a'},
                 {'op': 'put', 'key': 'c', 'value': 3}, {'op': 'put', 'key': 'd', 'value': 4}]):
        for call in (lambda: helper[1](ops), lambda: helper[1](3, ops), lambda: helper[1](ops, 3)):
            try:
                r = call()
                if isinstance(r, (list, tuple)) and len(r) == len(ops): ok = True; break
            except Exception:
                pass
        if ok: break
chk('operations helper returns state after each step', ok)
buf = io.StringIO()
with contextlib.redirect_stdout(buf): exec(compile(src, 'impl', 'exec'), {'__name__': '__main__'})
out = buf.getvalue().lower()
steps = len(re.findall(r'\b(get|put)\b', out))
chk('demo shows >= 12 get/put operations', steps >= 12)
chk('demo exercises eviction', 'evict' in out)
puts = re.findall(r"put\W+(?:key\W*)?'?(\w+)", out)
repeat_put = any(k in puts[:i] for i, k in enumerate(puts))
chk('demo shows hits and key updates', ('hit' in out or re.search(r'get.*->\s*\d', out)) and ('updat' in out or repeat_put))
print('helper:', helper[0] if helper else None)
print(f'SCORE {sum(o for _, o in score)}/{len(score)}')
