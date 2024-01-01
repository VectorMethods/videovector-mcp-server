# Security Policy

## Supported Versions

Security fixes are applied to the latest published major version.

## Reporting a Vulnerability

Do not open a public issue for a suspected vulnerability.

Email `support@vectormethods.com` with:

- affected version or commit
- impact summary
- reproduction steps
- any logs with secrets removed

We will acknowledge credible reports and coordinate remediation before public disclosure.

## Secret Handling

Never include real API keys, service-account JSON, cloud connector credentials, webhook signing secrets, OAuth tokens, passwords, or private deployment values in issues, pull requests, examples, or tests.

The repository intentionally excludes private VectorMethods deployment scripts, cloud project IDs, service accounts, and backend control-plane code.
