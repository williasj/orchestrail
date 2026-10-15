# -*- coding: utf-8 -*-
"""Grader for the Vaultwarden + Caddy compose benchmark.
Usage: python3 grade_compose.py docker-compose.yml Caddyfile
(Either file may hold both, split at a line starting with '# Caddyfile'.)"""
import re, sys, yaml
craw = open(sys.argv[1], encoding='utf-8').read()
fraw = open(sys.argv[2], encoding='utf-8').read() if len(sys.argv) > 2 else ''
if '# Caddyfile' in craw and not fraw:
    k = craw.index('# Caddyfile'); craw, fraw = craw[:k], craw[k:]
doc = yaml.safe_load(craw)
score = []
def chk(n, ok):
    score.append(bool(ok)); print('PASS' if ok else 'FAIL', n)
S = doc['services']
def find(word): return [S[k] for k in S if word in (str(S[k].get('image', '')) + k).lower()][0]
v, c = find('vaultwarden'), find('caddy')
vols = doc.get('volumes') or {}
def named(svc): return [str(x).split(':')[0] for x in svc.get('volumes', []) if str(x).split(':')[0] in vols]
chk('vaultwarden data in a named volume', named(v))
chk('caddy data + config in named volumes', len(named(c)) >= 2)
chk('only caddy publishes ports', 'ports' not in v and c.get('ports'))
ports = ' '.join(map(str, c.get('ports', [])))
chk('80, 443 and 443/udp published', all(p in ports for p in ('80:80', '443:443', '443:443/udp')))
nets = doc.get('networks') or {}
vn = v.get('networks', []); vn = list(vn) if not isinstance(vn, dict) else list(vn)
cn = c.get('networks', []); cn = list(cn) if not isinstance(cn, dict) else list(cn)
chk('vaultwarden only on internal network(s) that caddy shares', vn and all((nets.get(n) or {}).get('internal') for n in vn) and set(vn) & set(cn))
venv = v.get('environment', {}); venv = dict(e.split('=', 1) for e in venv) if isinstance(venv, list) else venv
chk('ADMIN_TOKEN from env, no literal secret', str(venv.get('ADMIN_TOKEN', '')).startswith('${ADMIN_TOKEN'))
dval = str(venv.get('DOMAIN', ''))
documented_url = re.search(r'DOMAIN\b[^\n]*(https://|scheme)', craw) is not None
chk('vaultwarden DOMAIN is a full https URL', dval.startswith('https://') or (dval.startswith('${') and documented_url))
chk('both restart unless-stopped', v.get('restart') == c.get('restart') == 'unless-stopped')
hc = ' '.join(map(str, (v.get('healthcheck') or {}).get('test', [])))
chk('healthcheck uses a tool the image ships (curl or /healthcheck.sh)', re.search(r'curl|/healthcheck\.sh', hc) and 'wget' not in hc)
fcode = '\n'.join(l for l in fraw.splitlines() if not l.strip().startswith('#'))
chk('Caddyfile uses Caddy env syntax {$DOMAIN}', '{$DOMAIN' in fcode and '${DOMAIN}' not in fcode)
chk('Caddyfile reverse_proxy to vaultwarden', re.search(r'reverse_proxy\s+\S*vaultwarden', fraw))
chk('websocket notifications path handled', '/notifications/hub' in fraw)
print(f'SCORE {sum(score)}/{len(score)}')
