"""Check recovered bytes and Python syntax without executing business code."""
import ast
import hashlib
import json
import pathlib

repo = pathlib.Path(__file__).resolve().parent.parent
audit = json.loads((repo / 'maintenance/install-recovery-audit-20260912.json').read_text('utf-8'))
backup = pathlib.Path(audit['maintenanceRoot']).parent
snapshot = backup / 'snapshot/install'
old, new = audit['installRoot'], audit['recoveryRoot']
variants = [
    (old.replace('\\', '\\\\'), new.replace('\\', '\\\\')),
    (old.replace('\\', '/'), new.replace('\\', '/')),
    (old, new),
]
changed = []
preserved = 0
for row in audit['extras']:
    original = (snapshot / row['relativePath']).read_bytes()
    current = pathlib.Path(row['destination']).read_bytes()
    if hashlib.sha256(original).hexdigest() != row['sha256']:
        raise RuntimeError('Original snapshot hash mismatch: ' + row['relativePath'])
    if row['category'] == 'business' and row['relativePath'].endswith('.py'):
        expected = original.decode('utf-8')
        for before, after in variants:
            expected = expected.replace(before, after)
        actual = current.decode('utf-8')
        if actual.replace('\r\n', '\n') != expected.replace('\r\n', '\n'):
            raise RuntimeError('Unexpected script edit: ' + row['relativePath'])
        if current != original:
            try:
                ast.parse(actual)
            except SyntaxError:
                raise RuntimeError('Recovered script syntax invalid: ' + row['relativePath']) from None
            changed.append({'file': row['relativePath'], 'originalSha256': row['sha256'], 'currentSha256': hashlib.sha256(current).hexdigest()})
        else:
            preserved += 1
    else:
        if current != original:
            raise RuntimeError('Unexpected non-script edit: ' + row['relativePath'])
        preserved += 1
report = {'ok': True, 'exactFilesChecked': len(audit['extras']), 'scriptsRebased': len(changed), 'bytePreserved': preserved, 'syntaxValid': len(changed), 'scripts': changed}
report_path = backup / 'script-path-updates.json'
report_bytes = (json.dumps(report, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
if report_path.exists():
    if report_path.read_bytes() != report_bytes:
        raise RuntimeError('Existing script verification report differs')
else:
    with report_path.open('xb') as handle:
        handle.write(report_bytes)
print(json.dumps({key: value for key, value in report.items() if key != 'scripts'}, ensure_ascii=False))
