from pathlib import Path
import runpy


runpy.run_path('scripts/agent-apply-audit-corrections-v2.py', run_name='__main__')

path = Path('backend/services/amy/crawlerMetrics.js')
text = path.read_text(encoding='utf-8')
old = "(candidate?.genericOnly == null && candidate?.generic === true)"
new = "((candidate?.genericOnly === null || candidate?.genericOnly === undefined) && candidate?.generic === true)"
count = text.count(old)
if count != 1:
    raise RuntimeError(f'{path}: expected one strict-nullish replacement, found {count}')
path.write_text(text.replace(old, new, 1), encoding='utf-8')
print('v3 strict-nullish refinement staged')
