# {{SERVICE_NAME}}

{{PURPOSE}}
<!-- from services/index.js validateService list + comment, else inferred -->

## Declared Capability
- Allowed via: `services/index.js`
- Config namespace: {{CONFIG_NAMESPACE}}  <!-- services_config | gp_services_config -->

## Configuration
| Field | Source |
|---|---|
{{CONFIG_FIELD_TABLE}}
<!-- from services.config.js entry for this service: uri, url, api_key (ref only, never value), profile_key, etc -->

## Methods Called
{{METHODS_CALLED_TABLE}}
<!-- one row per distinct services("{{SERVICE_NAME}}").call("<method>", ...) found across handlers -->
| Method | Called From | Payload Shape |
|---|---|---|

## Used By
{{USED_BY_LIST}}
<!-- route names / handler files where this service is called -->