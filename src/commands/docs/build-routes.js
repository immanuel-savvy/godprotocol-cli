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
    const handlerDetails = await extractHandlerDetails(
      route.handler?.source ?? null,
      {
        handlerFile: route.handler?.file ?? null,
        projectRoot,
        maxFiles: 100,
        maxFunctions: 500,
        maxDepth: 20,
      },
    );

    built.push({
      name: route.name,
      category: route.category,
      security: route.security,
      routeFile: route.routeFile,
      handler: route.handler,
      request: buildRequestSchema(route.schemaRaw),
      response: {
        ref: "StandardResponse",
        data: handlerDetails.responseDataFields,
      },
      externalServices: handlerDetails.externalServices,
      errors: handlerDetails.errors,
      purpose: handlerDetails.purpose,
    });
  }

  // One Markdown page per handler source file.
  await renderRouteFiles(built, docsRoot);

  // One machine-readable route index.
  await renderRoutesJson(built, docsRoot);

  return built;
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

async function renderRouteFiles(built, docsRoot) {
  const apiDir = path.join(docsRoot, "api");

  await fs.mkdir(apiDir, { recursive: true });

  /*
   * ------------------------------------------------------------
   * 1. Remove previously generated API markdown files
   * ------------------------------------------------------------
   *
   * This prevents stale files such as:
   *
   *   v3.md
   *   workflows_router.md
   *   unresolved.md
   *
   * from surviving between generations.
   */
  const existingApiFiles = await collectMarkdownFiles(apiDir);

  for (const relativeFile of existingApiFiles) {
    const fullPath = path.join(apiDir, relativeFile);

    try {
      await fs.unlink(fullPath);
    } catch (error) {
      console.warn(`Failed to remove stale API document: ${fullPath}`, error);
    }
  }

  /*
   * ------------------------------------------------------------
   * 2. Group routes by their ACTUAL HANDLER FILE
   * ------------------------------------------------------------
   *
   * This is the important distinction:
   *
   *   route.routeFile   = router-v3.js
   *
   *   route.handler.file = createChatSession.js
   *
   * The second one determines the documentation filename.
   */
  const byHandlerFile = new Map();

  for (const route of built) {
    const handlerFile = route.handler?.file;

    /*
     * Unresolved handlers do not get documentation files.
     *
     * In particular, NEVER create:
     *
     *   unresolved.md
     *   null.md
     *   undefined.md
     */
    if (!handlerFile) {
      console.warn(`Skipping unresolved handler documentation: ${route.name}`);

      continue;
    }

    const normalizedHandlerFile = path.resolve(handlerFile);

    if (!(await exists(normalizedHandlerFile))) {
      console.warn(`Skipping missing handler file: ${normalizedHandlerFile}`);

      continue;
    }

    if (!byHandlerFile.has(normalizedHandlerFile)) {
      byHandlerFile.set(normalizedHandlerFile, []);
    }

    byHandlerFile.get(normalizedHandlerFile).push(route);
  }

  /*
   * ------------------------------------------------------------
   * 3. Generate one Markdown file per handler source file
   * ------------------------------------------------------------
   */
  const generatedDocuments = [];

  for (const [handlerFile, routes] of byHandlerFile.entries()) {
    const originalFileName = path.basename(
      handlerFile,
      path.extname(handlerFile),
    );

    const fileName = sanitizeDocFileName(originalFileName);

    if (!fileName) {
      console.warn(
        `Skipping handler with invalid documentation filename: ${handlerFile}`,
      );

      continue;
    }

    /*
     * IMPORTANT:
     *
     * This is derived from handlerFile.
     *
     * Therefore:
     *
     * router-v3.js
     *
     * cannot accidentally become:
     *
     * v3.md
     */
    const outputPath = path.join(apiDir, `${fileName}.md`);

    const lines = [`# ${capitalize(originalFileName)} API`, ""];

    for (const route of routes) {
      lines.push(`## ${route.name}`);
      lines.push("");

      if (route.purpose) {
        lines.push(escapeMarkdownValue(route.purpose));
        lines.push("");
      }

      /*
       * Endpoint information
       */
      lines.push("### Endpoint");
      lines.push("");

      lines.push("| Property | Value |");
      lines.push("| --- | --- |");

      lines.push(
        `| Method | \`${escapeMarkdownValue(route.method ?? "N/A")}\` |`,
      );

      lines.push(
        `| Route | \`${escapeMarkdownValue(
          route.path ?? route.name ?? "N/A",
        )}\` |`,
      );

      lines.push(
        `| Security | \`${escapeMarkdownValue(route.security ?? "none")}\` |`,
      );

      lines.push("");

      /*
       * Request
       */
      if (route.request) {
        lines.push("### Request");
        lines.push("");

        lines.push(renderRequestTable(route.request));

        lines.push("");
      }

      /*
       * Response
       */
      if (route.response) {
        lines.push("### Response");
        lines.push("");

        lines.push(
          `Extends \`${escapeMarkdownValue(
            route.response.ref ?? "StandardResponse",
          )}\`.`,
        );

        lines.push("");

        lines.push("| Field | Type | Description |");
        lines.push("| --- | --- | --- |");
        lines.push("| `ok` | `boolean` | Whether the request succeeded |");
        lines.push(
          "| `message` | `string` | Human-readable response message |",
        );
        lines.push("| `data` | `object` | Response payload (see below) |");

        lines.push("");

        lines.push("#### Response Data");
        lines.push("");

        lines.push(renderResponseDataTable(route.response.data));
        lines.push("");
      }

      /*
       * External services
       */
      if (
        Array.isArray(route.externalServices) &&
        route.externalServices.length > 0
      ) {
        lines.push("### External Services");
        lines.push("");

        lines.push("| Service | Details |");
        lines.push("| --- | --- |");

        for (const service of route.externalServices) {
          if (typeof service === "string") {
            lines.push(`| ${escapeMarkdownValue(service)} | |`);

            continue;
          }

          lines.push(
            `| ${escapeMarkdownValue(
              service?.name ?? "Unknown",
            )} | ${escapeMarkdownValue(service?.description ?? "")} |`,
          );
        }

        lines.push("");
      }

      /*
       * Errors
       */
      if (Array.isArray(route.errors) && route.errors.length > 0) {
        lines.push("### Errors");
        lines.push("");

        lines.push("| Error | Description |");
        lines.push("| --- | --- |");

        for (const error of route.errors) {
          if (typeof error === "string") {
            lines.push(`| ${escapeMarkdownValue(error)} | |`);

            continue;
          }

          lines.push(
            `| ${escapeMarkdownValue(
              error?.code ?? error?.name ?? "Error",
            )} | ${escapeMarkdownValue(
              error?.message ?? error?.description ?? "",
            )} |`,
          );
        }

        lines.push("");
      }

      /*
       * Handler information
       */
      lines.push("### Handler");
      lines.push("");

      lines.push(`\`${handlerFile}\``);

      lines.push("");

      /*
       * Separate multiple routes handled by the same function.
       */
      lines.push("---");
      lines.push("");
    }

    await fs.writeFile(outputPath, `${lines.join("\n").trim()}\n`, "utf8");

    generatedDocuments.push({
      fileName,
      title: capitalize(originalFileName),
      path: outputPath,
      routes,
    });

    console.log(
      `Generated API document: ${path.relative(docsRoot, outputPath)}`,
    );
  }

  /*
   * ------------------------------------------------------------
   * 4. ALWAYS generate api/index.md
   * ------------------------------------------------------------
   *
   * sidebars.js expects this document.
   */
  const indexLines = [
    "# API Reference",
    "",
    "This section contains the API documentation generated from the application's handler files.",
    "",
  ];

  if (generatedDocuments.length === 0) {
    indexLines.push("No resolved API handlers were found.", "");
  } else {
    indexLines.push(
      "## Available APIs",
      "",
      "| API | Routes |",
      "| --- | ---: |",
    );

    for (const document of generatedDocuments) {
      const routeCount = document.routes.length;

      indexLines.push(
        `| [${escapeMarkdownValue(
          document.title,
        )}](/docs/api/${document.fileName}) | ${routeCount} |`,
      );
    }

    indexLines.push("");
  }

  const indexPath = path.join(apiDir, "index.md");

  await fs.writeFile(indexPath, `${indexLines.join("\n").trim()}\n`, "utf8");

  console.log(`Generated API index: ${path.relative(docsRoot, indexPath)}`);
}

function renderResponseDataTable(fields) {
  if (!Array.isArray(fields) || fields.length === 0) {
    return "_No response `data` fields could be determined from this handler._";
  }

  const lines = ["| Field | Type | Description |", "| --- | --- | --- |"];

  for (const field of fields) {
    if (typeof field === "string") {
      lines.push(`| \`${escapeMarkdownValue(field)}\` | — | — |`);
      continue;
    }

    const name = field?.field ?? field?.name ?? "unknown";
    const type = field?.type ?? "any";
    const description = field?.description ?? "—";

    lines.push(
      `| \`${escapeMarkdownValue(name)}\` | \`${escapeMarkdownValue(
        type,
      )}\` | ${escapeMarkdownValue(description)} |`,
    );
  }

  return lines.join("\n");
}

function renderRequestTable(request) {
  if (!request || !request.defined) {
    return "_No schema defined for this route — request shape is unvalidated._";
  }

  const rows = mergeFieldsWithLogic(request.body ?? [], request.logic);

  if (!rows || rows.length === 0) {
    return "_No request fields could be determined for this route._";
  }

  const lines = [
    "| Field | Type | Required | Description |",
    "| --- | --- | --- | --- |",
  ];

  for (const row of rows) {
    const field = row?.field ?? row?.name ?? "unknown";
    const type = row?.type ?? "any";

    const required =
      row?.required === true
        ? "Yes"
        : row?.required
          ? escapeMarkdownValue(row.required)
          : "No";

    const description = row?.description ?? row?.constraints ?? "";

    lines.push(
      `| \`${escapeMarkdownValue(field)}\` | \`${escapeMarkdownValue(
        type,
      )}\` | ${required} | ${escapeMarkdownValue(description)} |`,
    );
  }

  return lines.join("\n");
}
/*
 * ------------------------------------------------------------
 * Markdown helpers
 * ------------------------------------------------------------
 */

async function collectMarkdownFiles(dir, relativeDir = "") {
  if (!(await exists(dir))) {
    return [];
  }

  const entries = await fs.readdir(dir, {
    withFileTypes: true,
  });

  const files = [];

  for (const entry of entries) {
    const absolutePath = path.join(dir, entry.name);

    const relativePath = path.join(relativeDir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectMarkdownFiles(absolutePath, relativePath)));

      continue;
    }

    if (entry.isFile() && /\.(md|mdx)$/i.test(entry.name)) {
      files.push(relativePath);
    }
  }

  return files;
}

function sanitizeDocFileName(value) {
  return String(value ?? "")
    .replace(/\.(md|mdx)$/i, "")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function capitalize(value) {
  return String(value ?? "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function escapeMarkdownValue(value) {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "object") {
    try {
      return escapeMarkdownValue(JSON.stringify(value));
    } catch {
      return "";
    }
  }

  return String(value)
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderObjectTable(object) {
  const entries = Object.entries(object ?? {});

  if (entries.length === 0) {
    return ["| Property | Value |", "| --- | --- |", "| — | — |"].join("\n");
  }

  const lines = ["| Property | Value |", "| --- | --- |"];

  for (const [key, value] of entries) {
    lines.push(
      `| \`${escapeMarkdownValue(key)}\` | ${escapeMarkdownValue(value)} |`,
    );
  }

  return lines.join("\n");
}

function renderSchemaTable(schema) {
  if (!schema || typeof schema !== "object") {
    return [
      "| Property | Type | Required | Description |",
      "| --- | --- | --- | --- |",
      "| — | — | — | — |",
    ].join("\n");
  }

  const properties =
    schema.properties ??
    schema.body?.properties ??
    schema.data?.properties ??
    {};

  const entries = Object.entries(properties);

  if (entries.length === 0) {
    return [
      "| Property | Type | Required | Description |",
      "| --- | --- | --- | --- |",
      "| — | — | — | — |",
    ].join("\n");
  }

  const required = new Set(
    Array.isArray(schema.required) ? schema.required : [],
  );

  const lines = [
    "| Property | Type | Required | Description |",
    "| --- | --- | --- | --- |",
  ];

  for (const [name, definition] of entries) {
    const type =
      definition?.type ?? (Array.isArray(definition?.enum) ? "enum" : "object");

    const description = definition?.description ?? "";

    lines.push(
      `| \`${escapeMarkdownValue(name)}\` | \`${escapeMarkdownValue(
        type,
      )}\` | ${required.has(name) ? "Yes" : "No"} | ${escapeMarkdownValue(
        description,
      )} |`,
    );
  }

  return lines.join("\n");
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function formatHandlerTitle(handlerName) {
  if (!handlerName) return "Unresolved Handler";

  return handlerName
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .replace(/\bApi\b/g, "API");
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

function escapeMarkdown(value) {
  return String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function renderResponseData(dataFields) {
  if (!dataFields || dataFields.length === 0) {
    return "_No `data` fields could be determined from this handler or its local helper functions._";
  }

  const lines = ["| Field | Type | Description |", "|---|---|---|"];

  for (const field of dataFields) {
    if (typeof field === "string") {
      lines.push(`| \`${escapeMarkdown(field)}\` | — | — |`);

      continue;
    }

    const name = field.field ?? field.name ?? "unknown";

    const type = field.type ?? "any";

    const description = field.description ?? "—";

    lines.push(
      `| \`${escapeMarkdown(name)}\` | ${escapeMarkdown(type)} | ${escapeMarkdown(description)} |`,
    );
  }

  return lines.join("\n");
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

async function renderApiIndex(handlerDocs, docsRoot) {
  const apiDir = path.join(docsRoot, "api");

  const lines = [
    "# API Reference",
    "",
    "API documentation grouped by handler source file.",
    "",
    "| Handler | Routes | Category |",
    "|---|---:|---|",
  ];

  for (const doc of handlerDocs) {
    const firstRoute = doc.routes[0];

    const categories = [
      ...new Set(doc.routes.map((route) => route.category).filter(Boolean)),
    ];

    lines.push(
      `| [${doc.fileName}](./${doc.fileName}.md) | ${doc.routes.length} | ${categories.join(", ") || "—"} |`,
    );
  }

  await fs.writeFile(path.join(apiDir, "index.md"), lines.join("\n"), "utf8");
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

function escapeMarkdownText(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}");
}

function markdownCode(value, language = "") {
  const text = String(value ?? "");

  return [`\`\`\`${language}`, text.replace(/```/g, "``\\`"), "```"].join("\n");
}
