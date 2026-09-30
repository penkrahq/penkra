# Penkra 0.14.3

- Restores the 0.14.0 right panel resize behavior, including the native App view bounds path.
- Adds local diagnostics for thread actions, provider runtime activity, connection changes, window state, and failures, with bounded storage and privacy controls.
- Makes Claude account switching preserve the selected account and isolated native thread state. Failed switches now finish cleanup before they are treated as terminal.
- Keeps agent Penkra writes authorized through a long provider turn and a steer, while rejecting writes after that turn ends.
- Fixes related thread behavior found during integration: delayed or retired sync acknowledgements after reconnect, Stop targeting the visible running turn, pending connection selection on an immediate send, and archive rejection recovery.

The desktop release does not publish registry Apps or deploy the hosted backend. The diagnostics QA fixture is limited to disposable Dev builds.

The remaining diagnostics coverage audit classifications are planned for 0.14.4; the audit is outside the 0.14.3 release gate.
