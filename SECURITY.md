# Security policy

Agent Huddle runs local listeners that can approve actions for Claude Code agents, so security reports are welcome.

## Reporting

Please report vulnerabilities privately through GitHub's "Report a vulnerability" button on this repository
(Security › Advisories). Do not open a public issue for a security problem. Include the version (`Settings › About`
or `apps/desktop/package.json`), steps to reproduce and the impact you expect.

## Scope

In scope: the hook and telemetry listener on `127.0.0.1`, the phone listener and pairing, the Electron main process
and IPC, the hook installer (`scripts/install-hooks.mjs`, `--remove-hooks`), auto-approve rules, and anything that
writes files (worktrees, reports, skills).

The threat model and the rules the code keeps are in [docs/SECURITY.md](docs/SECURITY.md).

## Known limits

- Skill writes check the target folder and then write in separate steps, so another program running as you could swap
  a folder for a link in the moment between the last check and the write. This is accepted for a local, single-user
  app: that program could already write the file itself, and every path written lies under a project folder you work
  in. Details in ADR-028 (docs/DECISIONS.md).
