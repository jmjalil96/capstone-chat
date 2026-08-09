# Capstone Chat operations

These runbooks operate the single Phase 8 Render Web Service and managed PostgreSQL database. Run
commands from the repository root at the exact deployed revision. Replace angle-bracket placeholders
locally; never paste credentials, employee content, provider payloads, or token-bearing URLs into an
issue, task, log, screenshot, or committed evidence file.

External provisioning, DNS changes, paid OpenRouter inference, disposable Render rehearsal
resources, and PITR recovery resources require the user's immediate authorization before execution.

## Runbooks

- [Provision and deploy](./provision-and-deploy.md)
- [Deploy and rollback](./deploy-and-rollback.md)
- [Incident response](./incident-response.md)
- [Database recovery](./database-recovery.md)
- [Providers and budget](./providers-and-budget.md)
- [Secret rotation](./secret-rotation.md)
- [Employee access](./employee-access.md)
- [Domain and TLS](./domain-and-tls.md)

## Evidence rules

Record UTC timestamps, deployment revision, migration number, safe outcome, duration, and operator.
Use counts and stable error categories only. Before attaching any output, scan it for email addresses,
cookies, authorization headers, database URLs, prompts, responses, summaries, search terms, titles,
drafts, provider bodies, raw model identifiers, and identity-action URLs.

Stop if a step would change the locked privacy, security, cost, retention, model, or recovery policy.
Do not improvise a second service, queue, cache, worker, public database path, or alternate provider.
