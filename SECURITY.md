# Security policy

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for security issues. Do not open a public issue containing credentials, resumes, private email, or exploit details.

## Sensitive local data

Real resumes, `config.json`, mail files, state, logs, and generated reports are gitignored. Contributors should never commit real candidate data or authentication material.

Job descriptions and email bodies are untrusted input. The semantic prompt explicitly prevents instructions embedded in postings from becoming agent instructions, and subscription CLI runs use a temporary read-only workspace.

The project removes common model API credential variables before invoking Codex or Claude and refuses API-key authentication for supported subscription modes.
