# Host capability tests

Raw output from probing the hosting account, taken 2026-11-08/09, kept
because the conclusions in
`docs/superpowers/specs/2026-11-09-cgi-deployment-design.md` rest on them and
they are not cheaply reproducible later.

Round 1 — can the host run the app at all?

- `test1.txt` — `python3` is 3.6.8, but `python3.12` is present.
- `test2.txt` — a backgrounded process is reaped at logout (`200` then `000`).
- `test3.txt`, `test3.png` — CGI works; `t.cgi` returned `cgi ok`.
- `test4.png` — `ProxyPass` in `.htaccess` 500s the whole site, so
  `mod_proxy` is not permitted. With `test2.txt` this closes the
  long-running-process option from both ends.

Round 2 — is CGI actually affordable?

- `round2/test1.txt` — python3.12.15, `venv` works, pip 23.2.1.
- `round2/test2.txt` — `pip install fastapi a2wsgi` succeeds, so PyPI is
  reachable. This mattered: egress from this host is selective, and both
  Mapillary and loc.gov are blocked to it.
- `round2/test3.txt` — cold start 0.35-0.46s for fastapi + pydantic, and
  0.36-0.40s for the app's full third-party import set.
