# Contributing

Thanks for improving Job Radar. Contributions should preserve three project boundaries:

1. Do not add auto-apply or screening-answer automation.
2. Do not bypass platform access controls or add authenticated scraping for services whose terms prohibit it.
3. Do not add pay-as-you-go model API integrations. Semantic matching must use an explicitly authenticated subscription CLI or a local model.

## Development

```bash
npm install --ignore-scripts
npm test
```

Keep collectors small and independently testable with local fixtures. Treat every posting, email body, and remote field as untrusted data. New source integrations must document their authorization model, freshness semantics, and rate behavior.

Open a focused pull request with tests and an explanation of any new network or credential requirements.
