# Async SPEC third correction plan — before edit

P1 publicclose authorization must use actual mutex-owned lifecycle not delayed libuv closingflag. Before mutating close_requested use prior close_requested or retirement_failed (and prior closing) as alreadyretiring; only publicretry=true recordsauthorization. Internalfalse remains neverretry. Add scripted firstdisconnectfail thensuccess; operationfailure startsclose, callerwaits actualfailedattempt before runninguv callsclose once, bothreports+joinedclose no callbackretry. No policy expansion. Corrected SPEC before QUALITY.
