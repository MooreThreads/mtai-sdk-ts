# Slice 2 reconnect buffering correction (user-authorized continuation)

Latest completed SPEC reports one remaining P2: connected facade routes commands to disposed conversation while awaiting native retirement. Original baseline enters reconnecting/buffering before disconnection join.

Bounded fix: after nonterminal untilFailed resolves, publish reconnecting/loading before awaited current.close; keep terminal protocol exceptions out of this path, preserve terminated-send rejection and resource join before replacement creation. No changes to any timeout, retry, scheduled reconnect, input or media policy.

Public facade regression for ordinary socket loss and scheduled reconnect: hold bridge retirement pending, assert reconnecting and no replacement yet; send a command successfully during retirement; release retirement, handshake replacement and verify exactly-once delivery there, never on retired socket. Run named SDK and affected app unit tests; coherent Slice2 SPEC then independent QUALITY with requested gpt-6-astra medium. No packaging/install/restart.
