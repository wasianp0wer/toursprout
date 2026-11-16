# Decision records

One file per non-obvious call, written when it is made and left alone
afterwards. A record explains the forces at the time, not the current state of
the code — if a decision is reversed, add a new record that supersedes it
rather than editing the old one.

Numbered in order. Start from `0001`.

Index:

- [0001](0001-three-axes-for-overlays.md): `kind`, `anchor` and `display` are independent axes.
- [0002](0002-the-tour-is-a-portable-document.md): the tour is a portable document.
- [0003](0003-the-editor-is-three-surfaces-on-one-state.md): the editor is three surfaces on one state.
- [0004](0004-media-comes-in-by-content-and-tools-wrap-the-scripts.md): media comes in by content; tools wrap the scripts.
- [0005](0005-schema-v3-locks-the-document.md): schema v3 locks the document — the last tightenings, and a migration registry.
- [0006](0006-host-it-one-session-per-browser.md): host it rather than package it; one session per browser; what left the server because the host cannot reach it.
- [0007](0007-serve-it-through-cgi.md): serve it through CGI behind an Apache front controller, because the host has no Passenger — supersedes 0006's hosting mechanism and leaves the rest of it standing.
- [0008](0008-ship-from-a-workstation.md): ship from a workstation, because CI reaches the host about one time in nine and a deterministic manual deploy beats a lottery — the trigger and the machine move, and 0007's mechanism stands.
- [0009](0009-the-look-is-in-the-document.md): the look is in the document — a theme of enumerated names and validated `#rrggbb`, not in `config.json`; marker colours travel as a parameter and the shared viewer must be handed back in its defaults; the primary button changed colour and that is the one visible change; `Tour.attribution` stays open. Answers 0005's "UI customization has nowhere to live".
