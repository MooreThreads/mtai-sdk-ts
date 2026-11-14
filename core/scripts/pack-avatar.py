#!/usr/bin/env python3
"""Build a standalone Linux ARM64 SDK package without touching source dist."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    core = Path(__file__).resolve().parents[1]
    repo = core.parent
    output = args.output.resolve()
    if output.exists():
        raise SystemExit('Output must be a new directory; retained artifacts are never overwritten')
    output.mkdir(parents=True)
    with tempfile.TemporaryDirectory(prefix='mtai-package-') as temporary:
        stage = Path(temporary) / 'package'
        stage.mkdir()
        subprocess.run([str(core / 'node_modules/.bin/tsc'), '-p', str(core / 'tsconfig.json'),
                        '--outDir', str(stage / 'dist')], check=True, cwd=core)
        subprocess.run(['bash', str(core / 'native/build.sh'), str(stage / 'native/mtai_avatar.node')], check=True)
        manifest = json.loads((core / 'package.json').read_text())
        commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip()
        # A distinct private prerelease must not overwrite the distributed SDK.
        inputs = {}
        for tree in [core / 'src', core / 'native']:
            for path in sorted(tree.rglob('*')):
                if path.is_file() and not path.name.endswith(('.test.ts', '.node')) and 'test' not in path.relative_to(tree).parts:
                    inputs[str(path.relative_to(repo))] = sha(path)
        for path in [core / name for name in ('package.json', 'package-lock.json', 'tsconfig.json', 'LICENSE', 'README.md')] + [Path(__file__)]:
            inputs[str(path.relative_to(repo))] = sha(path)
        identity = hashlib.sha256(json.dumps(inputs, sort_keys=True).encode()).hexdigest()
        manifest['version'] += f'-sharedtexture.{commit[:12]}.{identity[:12]}'
        manifest['private'] = True
        manifest.pop('publishConfig', None)
        manifest.pop('devDependencies', None)
        manifest['scripts'] = {}
        manifest['os'] = ['linux']
        manifest['cpu'] = ['arm64']
        manifest['files'] = ['dist', 'native/mtai_avatar.node', 'artifact.json', 'LICENSE', 'README.md']
        (stage / 'package.json').write_text(json.dumps(manifest, indent=2) + '\n')
        for name in ['LICENSE', 'README.md']:
            shutil.copy2(core / name, stage / name)
        artifact = {'sourceCommit': commit,
                    'workingTreeStatus': subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=normal'], cwd=repo, text=True).splitlines(),
                    'sourceInputsSha256': inputs, 'inputIdentity': identity,
                    'platform': 'linux-arm64', 'napi': 8,
                    'runtimeLibraries': ['libpipewire-0.3.so.0', 'libuv.so.1'],
                    'filesSha256': {str(p.relative_to(stage)): sha(p) for p in sorted(stage.rglob('*')) if p.is_file()}}
        (stage / 'artifact.json').write_text(json.dumps(artifact, indent=2) + '\n')
        result = subprocess.check_output(['npm', 'pack', '--ignore-scripts', '--json', '--pack-destination', str(output)], cwd=stage, text=True)
        tarball = output / json.loads(result)[0]['filename']
        (output / 'receipt.json').write_text(json.dumps({'artifact': tarball.name, 'sha256': sha(tarball),
            'sourceCommit': commit, 'inputIdentity': identity}, indent=2) + '\n')
        print(tarball)
        print('SHA-256', sha(tarball))


if __name__ == '__main__':
    main()
