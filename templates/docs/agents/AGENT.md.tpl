# Agent Documentation

This folder contains machine-readable mirrors of the human docs in `../`.

- `routes.json` — one entry per route: name, handler, security, request/response shape, external services called
- `services.json` — one entry per declared external service: config fields (keys only, never values), methods observed in use
- `datastructures.json` — shared shapes referenced by routes
- `architecture.json` — project-level counts and service/router graph

Schema version: see `$schema` field in each file. Fields marked
`"confidence": "extracted"` came directly from static analysis.
Fields marked `"confidence": "inferred"` were filled by an LLM from
handler source and may need verification.