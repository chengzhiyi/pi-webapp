# Security policy

## Reporting a vulnerability

Please don't report security problems in public issues, discussions or pull requests.

Report them privately through [GitHub's private vulnerability reporting](https://github.com/chengzhiyi/pi-webapp/security/advisories/new). Include:

- the affected version (shown under Settings as the current version, or `npm ls -g pi-webapp`) and platform
- steps to reproduce, or a proof of concept
- the impact you expect, for example code execution, data exposure or bypassing a confirmation

We aim to acknowledge reports within 7 days and will keep you updated until a fix is released. We credit reporters in the release notes unless you'd rather stay anonymous.

## Supported versions

Security fixes go into the latest release on the `latest` (stable) and `alpha` npm channels. Please update before reporting.

## Scope

pi-webapp runs locally with your user's permissions. Hosted plugins run in a separate Node process for lifecycle management; that process is not a security sandbox, so a plugin you choose to install having your permissions is expected behavior, not a vulnerability.
