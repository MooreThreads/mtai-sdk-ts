# Slice 3 checkpoint — artifact checks completed, review pending

## Scope
DH2D actual frozen builder now builds RGBA library, includes local_media and stages library for both frozen lib/ and swappable root module locations. SDK production build/pack uses isolated dist, Linux ARM64 NAPI8 addon without fixture exports; hash/provenance records distinguish dirty source inputs from HEAD. App exact SDK tar, root/runtime npm+yarn locks, selected Electron40.10.6, native externalization/ASAR unpacking and libpipewire/libuv Debian dependencies. Version0.1.25 distinguishes new app contents from installed0.1.24.

Main's native path is resolved relative to actual app.getAppPath(), not webpack require.resolve (which experimentally produced a numeric webpack module ID). Renderer bundles portable/React; main/preload externalize SDK subpaths; runtime package includes exact same tarball. No media lifecycle/runtime policy changes.

## Artifact/provenance
- SDK source HEAD f0091269afc45aaaac9002e42c110e9c4256ddfa plus explicit dirty input hashes/workingTreeStatus in tar artifact.json.
- Tar `mtai-0.2.21-sharedtexture.f0091269afc4.11a30ebbe9f4.tgz`, SHA256 `c84188757c2b67b0daeb3178157a5c7b36b46a8dea3fbf1af5f4d795907ad7b7`.
- Isolated app snapshot `/tmp/avatar-slice3-build.go7itrrc` from app HEAD a118e1ec plus current changed files, actual frozen yarn dependencies under `/tmp/avatar-artifact-locks.xtdvi2gg` (original worktree dependencies unchanged).
- System-FPM-built `dist/2d-digitalme-avatar_0.1.25_arm64.deb`, SHA256 `28ec6c0c3a399fc9cf11e1fe6f5ff3e920684e45b269b1ee0cd19276b9ec46d1`; not installed/distributed. Preliminary artifact includes uncommitted packaging source and is not a final committed release.
- Electron binary copied from isolated pinned40.10.6 distribution, version checked using packaged binary. Private existing local videos used read-only from existing `.local-assets`; no asset upload or changes.

## Verification
- SDK tsc and named19 suites354 cases PASS.
- App production webpack main/preload and renderer builds PASS in isolated snapshot. Typechecking remains separate: previously inherited19 source diagnostic signatures not repaired or claimed green.
- Actual packed SDK: Node and Electron40.10.6 run-as-node load portable/main/preload/React and production addon without creating media owners. Addon exports exactly createConnection/createPlayback/monotonicNs.
- App4 named suites19 PASS, now including complete tar integrity test and additional root/runtime/receipt binding checks. No artifact test excluded.
- Actual electron-builder unpacked artifact generated; scripts/verify-avatar-artifact.cjs verifies100 SDK runtime payloads, exact native unpacked bytes and metadata/receipt, then packaged Electron module loads. Builder deliberately removes48 declaration files and scripts/keywords metadata; verification models only these observed exclusions. Full SDK development tar remains byte-checked in app test.
- DH2D new2 packaging API tests PASS; RGBA Werror compile succeeds outside source, ldd no missing dependencies. Full existing frozen batch50:49 pass,1 inherited LFS fixture error reproduced using unmodified HEAD builder+test. Existing mocked profile test migrated only to stub the new compilation/staging boundary; no assertion weakened.
- SDK/app/DH2D diff --check PASS before review.
- npm lock updates targeted: root + Electron/get/types/undici/SDK entries and3 required closure additions; no old package entries removed, unrelated metadata/version churn excluded. Yarn preserves unrelated selectors/versions and adds only required new closure/SDK selectors. Runtime locks add SDK+QR.

## Retained failures
- First DH2D compile invocation omitted temporary output parent; corrected operator setup, not native behavior.
- First production main bundle used webpack numeric require.resolve; corrected to explicit runtime app path and rebuilt.
- First Debian attempt downloaded x86 FPM (missing ld-linux.so.2); existing USE_SYSTEM_FPM=true succeeds.
- First artifact verifier discovered builder pruning declarations/scripts/keywords; bounded verifier now checks remaining runtime bytes and exact manifest after only those exclusions.
- Broader inherited LFS fixture failure retained; no whole frozen build qualification claim.

## Not established
No GPU/audio device initialization, live output, all-reference retirement on hardware, physical display/color/orientation/alpha, AEC/recording preservation or installed end-to-end qualification. No install/restart/push of this unreviewed Slice3. SDK Slice2 GitHub push remains blocked; app/DH2D Slice2 pushed. Rebuild committed artifact after approval before release promotion.
