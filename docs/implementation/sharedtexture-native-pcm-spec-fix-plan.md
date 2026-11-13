# PCM SPEC witness fix — before edit

P2 original plan explicitly requires conservative mixed handed scope history, not merely B-only protection. Add standalone public API test: submit A and B, copy all A plus initial B bytes in one process with no reset, stopA rejects flush permission/reset, resume exact B suffix and original completion identity once. Preserve existing cancelled-only/unknown/B-arriving cases; production unchanged. Rerun native tests then corrected max SPEC and independent QUALITY. No new product behavior/timeouts/limits.
