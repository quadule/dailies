# Claude / Agent Instructions

See [`AGENTS.md`](AGENTS.md) for project orientation, architecture, and validation steps.

## Driving a browser

Every browser interaction in this repo goes through Dailies's own CLI — `dailies`
(or `npx dailies-cli`) and the scripts it runs. Do **not** use Claude
in Chrome, a computer-use / screenshot tool, or any other browser automation to navigate, click,
fill, read, or view a page here — those bypass Dailies's sandbox, the on-screen cursor, and the
trace / video / HAR / report capture, so the run isn't recorded or verifiable. To QA or automate a
flow, use the Dailies skills (`dailies-session`, `dailies-automate`, `dailies-verify`,
`dailies-session-interactive`); to view a recorded session, open its `report.html`. If you catch
yourself reaching for another browser tool, stop and use Dailies instead.
