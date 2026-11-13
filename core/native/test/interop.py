"""Independent frozen-vector native interop runner; no device dependencies."""
import json
from pathlib import Path
import subprocess
import sys

binary, fixture = sys.argv[1:]
vectors = json.loads(Path(fixture).read_text())['vectors']
expected = [row['hex'] for row in vectors]
result = subprocess.run([binary, '--roundtrip'], input='\n'.join(expected)+'\n',
                        text=True, capture_output=True, check=True)
assert result.stdout.splitlines() == expected
print(f'{len(expected)} frozen vectors: native decode/reencode byte-exact')
