## {{ROUTE_NAME}}

{{PURPOSE}}

**Handler:** `{{HANDLER_NAME}}` ({{HANDLER_FILE}}:{{HANDLER_LINE}})
**Security:** {{SECURITY}}
**Resolved under:** `{{PREFIX_EXPR}}/{{ROUTE_NAME}}` — prefix is runtime-resolved via `validateRouter`; exact value depends on `services.config.js` at boot.

### Request
{{REQUEST_SHAPE}}
<!-- from route.schema.body if populated, else inferred from `body` destructuring in handler, marked (inferred) -->

### Response
See [StandardResponse](../datastructures/standard-response.md).
{{RESPONSE_DATA_SHAPE}}
<!-- only the `data` field varies per route — document that part here -->

### External Services Used
{{EXTERNAL_SERVICES_LIST}}
<!-- e.g. "- echo.listen(...) — see [echo](../services/echo.md)" , or "none" -->

### Errors
{{ERROR_TABLE}}
<!-- derived from `status`/`ok:false` returns in handler body -->