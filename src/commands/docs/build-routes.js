import fs from "node:fs/promises";
import path from "node:path";
import { scanRouterFiles } from "./scan-routes.js";
import { evaluateSchema, describeSchemaSection } from "./scan-schema.js";
import { extractHandlerDetails } from "./scan-handler-details.js";

const REQUIRED_RANK = { conditional: 2, "optional (group)": 1 };

export async function buildRoutes(projectRoot, docsRoot) {
  const rawRoutes = await scanRouterFiles(projectRoot);

  const built = [];

  for (const route of rawRoutes) {
    const request = buildRequestSchema(route.schemaRaw);

    const handlerDetails = extractHandlerDetails(route.handler?.source ?? null);

    /*
     * The API/documentation group is determined by the file
     * containing the imported handler.
     *
     * Example:
     *
     * import { create_chat_session } from "../handlers/chat.js"
     *
     * => API group: "chat"
     */
    const apiName = getHandlerApiName(route.handler?.file, route.handler?.name);

    built.push({
      name: route.name,

      /*
       * Keep the original router category for metadata/backwards
       * compatibility, but use apiName for documentation grouping.
       */
      category: route.category,

      apiName,

      security: route.security,

      routeFile: route.routeFile,

      handler: route.handler,

      request,

      response: {
        ref: "StandardResponse",
        data: handlerDetails.responseDataFields,
      },

      externalServices: handlerDetails.externalServices,

      errors: handlerDetails.errors,

      purpose: handlerDetails.purpose,
    });
  }

  /*
   * Group routes by the handler import file rather than
   * the router file.
   */
  const byApi = groupBy(built, "apiName");

  await renderRouteFiles(byApi, docsRoot);

  await renderApiIndex(built, docsRoot);

  await renderRoutesJson(built, docsRoot);

  return built;
}

function getHandlerApiName(handlerFile, handlerName = null) {
  if (!handlerFile) {
    return handlerName || "unresolved";
  }

  /*
   * Example:
   *
   * /project/handlers/chat.js
   *
   * => chat
   */
  const basename = path.basename(handlerFile, path.extname(handlerFile));

  /*
   * Make common handler naming conventions cleaner.
   *
   * chat.handler.js -> chat
   * chat.handlers.js -> chat
   * chat.controller.js -> chat
   * chat.controllers.js -> chat
   */
  return (
    basename
      .replace(/\.(handlers?|controllers?|controller)$/i, "")
      .replace(/[-_]+/g, "-")
      .trim() ||
    handlerName ||
    "default"
  );
}

function buildRequestSchema(schemaRaw) {
  if (!schemaRaw) {
    return { defined: false, body: [], logic: null, confidence: "extracted" };
  }
  const evaluated = evaluateSchema(schemaRaw);
  if (!evaluated.ok) {
    return {
      defined: false,
      body: [],
      logic: null,
      confidence: "extracted",
      evalError: evaluated.error,
    };
  }
  const bodyRules = evaluated.value.body ?? {};
  const { fields, logic } = describeSchemaSection(bodyRules);
  return {
    defined: fields.length > 0 || !!logic,
    body: fields,
    logic,
    confidence: "extracted",
  };
}

export function mergeFieldsWithLogic(fields, logic) {
  const byName = new Map(
    fields.map((f) => [f.field, { ...f, required: f.required ? true : false }]),
  );
  const markGroup = (properties, type, required) => {
    const label = required ? "conditional" : "optional (group)";
    for (const prop of properties) {
      if (byName.has(prop)) {
        const existing = byName.get(prop);
        existing.required = strongerRequired(existing.required, label);
      } else {
        byName.set(prop, {
          field: prop,
          type: type ?? "any",
          required: label,
          constraints: null,
          enum: null,
        });
      }
    }
  };
  if (logic?.or)
    logic.or.forEach((g) => markGroup(g.properties, g.type, !!g.required));
  if (logic?.and)
    logic.and.forEach((g) => markGroup(g.properties, g.type, !!g.required));
  return [...byName.values()];
}

function strongerRequired(current, incoming) {
  if (current === true) return true;
  if (typeof current !== "string") return incoming;
  return (REQUIRED_RANK[incoming] ?? 0) > (REQUIRED_RANK[current] ?? 0)
    ? incoming
    : current;
}

async function renderRouteFiles(byApi, docsRoot) {
  const apiDir = path.join(docsRoot, "api");

  await fs.mkdir(apiDir, { recursive: true });

  /*
   * Remove previously generated API pages so stale pages
   * don't remain after routes are moved between handler files.
   */
  const existingFiles = await fs.readdir(apiDir);

  for (const file of existingFiles) {
    if (!file.endsWith(".md")) {
      continue;
    }

    await fs.rm(path.join(apiDir, file), { force: true });
  }

  for (const [apiName, routes] of Object.entries(byApi)) {
    const lines = [
      `# ${capitalize(apiName)} API`,
      "",
      `This API contains ${routes.length} route${routes.length === 1 ? "" : "s"} handled by \`${apiName}\`.`,
      "",
    ];

    for (const route of routes) {
      lines.push(renderRoute(route), "---", "");
    }

    const filename = `${safeFileName(apiName)}.md`;

    await fs.writeFile(path.join(apiDir, filename), lines.join("\n"));
  }
}

function safeFileName(value) {
  return (
    String(value)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "default"
  );
}

function renderBodySection(request) {
  if (!request.defined) {
    return "_No schema defined for this route — request shape is unvalidated (`schema: { body: {} }`)._";
  }
  const rows = mergeFieldsWithLogic(request.body, request.logic);
  const lines = [
    "**Body**",
    "",
    "| Field | Type | Required | Constraints | Description |",
    "|---|---|---|---|---|",
  ];
  if (rows.length === 0) {
    lines.push("| _(none)_ | — | — | — | — |");
  } else {
    for (const r of rows) {
      lines.push(
        `| ${r.field} | ${r.type} | ${renderRequiredCell(r.required)} | ${r.constraints ?? "—"} | ${r.enum ? `enum: ${r.enum.join(", ")}` : "—"} |`,
      );
    }
  }
  const groupLines = renderLogicGroups(request.logic);
  if (groupLines.length) lines.push("", ...groupLines);
  return lines.join("\n");
}

function renderRequiredCell(required) {
  if (required === "conditional" || required === "optional (group)")
    return required;
  return required ? "**Yes**" : "No";
}

function renderLogicGroups(logic) {
  const lines = [];
  if (logic?.or) {
    for (const group of logic.or) {
      const props = group.properties.map((p) => `\`${p}\``).join(", ");
      lines.push(
        group.required
          ? `> **or** — at least one of the following is required: ${props}${group.type ? ` (type: \`${group.type}\`)` : ""}`
          : `> **or** — at most one of the following applies, none required: ${props}${group.type ? ` (type: \`${group.type}\`)` : ""}`,
      );
    }
  }
  if (logic?.and) {
    for (const group of logic.and) {
      const props = group.properties.map((p) => `\`${p}\``).join(", ");
      lines.push(
        group.required
          ? `> **and** — all of the following are required together: ${props}`
          : `> **and** — the following are validated together when present, not required: ${props}`,
      );
    }
  }
  return lines;
}

function renderResponseData(dataFields) {
  if (!dataFields || dataFields.length === 0) {
    return "_No `data` fields observed in this handler's return statements._";
  }
  return `\`data\` fields: ${dataFields.map((f) => `\`${f}\``).join(", ")}`;
}

function renderExternalServices(services) {
  if (!services || services.length === 0) return "none";
  return services
    .map(
      (s) =>
        `- \`${s.service}.${s.method}(...)\` — see [${s.service}](../services/${s.service}.md)`,
    )
    .join("\n");
}

async function renderApiIndex(routes, docsRoot) {
  const apiDir = path.join(docsRoot, "api");

  await fs.mkdir(apiDir, { recursive: true });

  const grouped = groupBy(routes, "apiName");

  const lines = [
    "# API Reference",
    "",
    "APIs grouped by their handler module.",
    "",
    "| API | Routes | Security | Handler File |",
    "|---|---:|---|---|",
  ];

  for (const [apiName, apiRoutes] of Object.entries(grouped)) {
    const firstRoute = apiRoutes[0];

    const handlerFile = firstRoute.handler?.file
      ? relFile(firstRoute.handler.file)
      : "unresolved";

    const securityValues = [
      ...new Set(apiRoutes.map((route) => route.security).filter(Boolean)),
    ];

    const security =
      securityValues.length > 0 ? securityValues.join(", ") : "none";

    lines.push(
      `| [${apiName}](./${safeFileName(apiName)}.md) | ${apiRoutes.length} | ${security} | \`${handlerFile}\` |`,
    );
  }

  await fs.writeFile(path.join(apiDir, "index.md"), lines.join("\n"));
}

function renderRoute(route) {
  const lines = [`## ${route.name}`, ""];

  lines.push(
    route.purpose ??
      "_No description available — add a comment above this route entry._",
    "",
  );

  lines.push(
    `**Handler:** \`${route.handler?.name ?? "unresolved"}\` (${relFile(route.handler?.file)}${route.handler?.line ? `:${route.handler.line}` : ""})`,
  );

  lines.push(`**Security:** ${route.security ?? "none"}`, "");

  lines.push("### Request", "");
  lines.push(renderBodySection(route.request), "");

  lines.push("### Response", "");

  lines.push(
    "See [StandardResponse](../datastructures/standard-response.md).",
    "",
  );

  lines.push(renderResponseData(route.response.data), "");

  lines.push(renderResponseVariants(route.response.variants), "");

  lines.push("### External Services Used", "");

  lines.push(renderExternalServices(route.externalServices), "");

  lines.push("### Errors", "");

  lines.push(renderErrors(route.errors), "");

  return lines.join("\n");
}

async function renderRoutesJson(routes, docsRoot) {
  const agentsDir = path.join(docsRoot, "agents");
  await fs.mkdir(agentsDir, { recursive: true });
  const payload = routes.map((r) => ({
    $schema: "godprotocol/v1/route.schema.json",
    name: r.name,
    category: r.category,
    security: r.security,
    handler: r.handler
      ? {
          name: r.handler.name,
          file: relFile(r.handler.file),
          line: r.handler.line,
        }
      : null,
    request: {
      defined: r.request.defined,
      body: r.request.body,
      logic: r.request.logic,
      confidence: r.request.confidence,
    },
    response: r.response,
    externalServices: r.externalServices,
    errors: r.errors,
    confidence: "extracted",
  }));
  await fs.writeFile(
    path.join(agentsDir, "routes.json"),
    JSON.stringify(payload, null, 2),
  );
}

function groupBy(items, key) {
  return items.reduce((acc, item) => {
    (acc[item[key]] ??= []).push(item);
    return acc;
  }, {});
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function relFile(file) {
  return file ? path.relative(process.cwd(), file) : "unresolved";
}

function renderResponseVariants(responses) {
  if (!responses || responses.length === 0) {
    return "_No response statuses observed in this handler._";
  }

  const lines = [
    "#### Response Statuses",
    "",
    "| Status | Code | OK | Data | Meaning |",
    "|---|---|---|---|---|",
  ];

  for (const response of responses) {
    const status = response.status != null ? response.status : "—";

    const code = response.status_code ? `\`${response.status_code}\`` : "—";

    const ok = response.ok == null ? "—" : response.ok ? "true" : "false";

    const data = response.data?.length
      ? response.data.map((field) => `\`${field}\``).join(", ")
      : "—";

    const meaning = response.meaning ?? "—";

    lines.push(`| ${status} | ${code} | ${ok} | ${data} | ${meaning} |`);
  }

  return lines.join("\n");
}

function renderErrors(errors) {
  const real = (errors ?? []).filter(
    (e) => e.status !== null || e.status_code || e.meaning,
  );

  if (real.length === 0) {
    return "_No error responses observed in this handler._";
  }

  const lines = ["| Status | Code | Meaning |", "|---|---|---|"];

  for (const e of real) {
    lines.push(
      `| ${e.status ?? "—"} | ${
        e.status_code ? `\`${e.status_code}\`` : "—"
      } | ${e.meaning ?? "—"} |`,
    );
  }

  return lines.join("\n");
}
