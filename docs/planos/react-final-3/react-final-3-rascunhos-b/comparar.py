import json, re, sys
SP = sys.argv[1]
h = json.load(open(SP + "/" + sys.argv[2])); n = json.load(open(SP + "/" + sys.argv[3]))
# Artefatos de realm: Error/Map criados na VM aparecem como {} ao formatar; no Node aparecem como Error(...)/Map(...).
def norm(v):
    if isinstance(v, dict): return {k: norm(x) for k, x in v.items()}
    if isinstance(v, list): return [norm(x) for x in v]
    if isinstance(v, str) and (re.fullmatch(r"Error\(.*\)", v, re.S) or re.fullmatch(r"Map\(\d+\)", v)): return "{}"
    return v
diffs = []
def walk(a, b, path=""):
    if isinstance(a, dict) and isinstance(b, dict):
        for k in set(a) | set(b):
            if k not in a or k not in b: diffs.append((path + "/" + k, "falta", k in a, k in b)); continue
            walk(a[k], b[k], path + "/" + k)
    elif isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b): diffs.append((path, "tamanho", len(a), len(b)))
        for i, (x, y) in enumerate(zip(a, b)): walk(x, y, path + f"[{i}]")
    elif a != b: diffs.append((path, a, b))
walk(norm(h), norm(n))
print("diferencas apos normalizar Error/Map de realm:", len(diffs))
for d in diffs[:20]: print(d)
