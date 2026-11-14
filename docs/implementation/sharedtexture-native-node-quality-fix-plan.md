# Node QUALITY fix plan — before edits

P1 failure deferred settlement must have same retained async CallbackScope as joinedretire. Scope encloses rejectbatch+observercall; clear observerexception, scope drains rejectionmicrotasks even observerthrows, no automatic retry. Test failedobserverthrow with rejectionhandler explicitretry and referencedidleMessagePort.
P1 close fence before Promiseinit: allocate/link own placeholder node first, set closing and request actualnativeclose exactlyonce before napi_create_promise; if creation fails remove exactplaceholder without reopening fence. Existing listbatch identity/reentryownership preserved. Promiseinit hook attempts submit/stop/end allreject. No timeouts/limits/nativepolicy change; corrected SPEC then separate QUALITY.
