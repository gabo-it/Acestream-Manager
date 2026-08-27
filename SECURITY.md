# Security Policy

## Supported Versions

Only the latest tagged release (and the `latest` image tag) receives
security fixes — this is a small, self-maintained project without the
resources to backport fixes across multiple versions.

| Version | Supported          |
| ------- | ------------------ |
| Latest  | :white_check_mark: |
| Older   | :x:                |

## Reporting a Vulnerability

Please **do not** open a public issue for security vulnerabilities.

Instead, report it privately via GitHub's Security Advisories:
[Report a vulnerability](https://github.com/gabo-it/Acestream-Manager/security/advisories/new)
(repo → Security tab → "Report a vulnerability").

Include as much detail as you can: which service is affected (`webui`,
`acestream`, `acexy` config), reproduction steps, and potential impact.

You should get an initial response within a few days. This is a hobby
project maintained in spare time, so please be patient — but reports are
taken seriously and fixed as soon as practical.

## Scope notes

- `acexy` and the AceStream engine itself are third-party components — for
  vulnerabilities specific to them (not to how this project configures or
  wraps them), please report upstream:
  [acexy](https://github.com/Javinator9889/acexy/security) /
  [AceStream](https://acestream.org/).
- This stack is designed for use on a trusted local network or behind your
  own access controls — it does not include built-in authentication for the
  web UI. If exposing it beyond your LAN, put a reverse proxy with
  authentication in front of it.
