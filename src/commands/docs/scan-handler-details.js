/*
 * Dependency-free handler scanner.
 *
 * Extracts:
 * - purpose / leading comments
 * - response status
 * - response status_code
 * - response ok
 * - response data fields
 * - errors
 * - service calls
 * - service method
 * - service call arguments/context
 *
 * No external dependencies.
 */

export function extractHandlerDetails(handlerBody) {
  if (!handlerBody) {
    return {
      purpose: null,
      responseDataFields: [],
      responses: [],
      errors: [],
      externalServices: [],
    };
  }

  const responses = extractResponses(handlerBody);

  return {
    purpose: extractLeadingComment(handlerBody),
    responseDataFields: extractResponseDataFields(handlerBody),
    responses,
    errors: responses.filter((r) => {
      if (r.status == null) return false;
      return r.status >= 400;
    }),
    externalServices: extractExternalServiceCalls(handlerBody),
  };
}

/* -------------------------------------------------------------------------- */
/* Purpose                                                                    */
/* -------------------------------------------------------------------------- */

function extractLeadingComment(body) {
  const trimmed = body.trim();

  const lineComment = trimmed.match(/^\/\/\s*(.+?)(?:\r?\n|$)/);
  if (lineComment) {
    return lineComment[1].trim();
  }

  const blockComment = trimmed.match(/^\/\*\*?\s*([\s\S]*?)\s*\*\//);

  if (blockComment) {
    return blockComment[1]
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*\*\s?/, "").trim())
      .filter(Boolean)
      .join(" ");
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* Responses                                                                  */
/* -------------------------------------------------------------------------- */

function extractResponses(source) {
  const responses = [];
  const returnPattern = /\breturn\s*(?=\{)/g;

  let match;

  while ((match = returnPattern.exec(source))) {
    const openIndex = source.indexOf("{", match.index);

    if (openIndex === -1) continue;

    const closeIndex = findMatchingClose(source, openIndex, "{", "}");

    if (closeIndex === -1) continue;

    const objectText = source.slice(openIndex + 1, closeIndex);

    const response = parseResponseObject(objectText);

    if (response) {
      responses.push(response);
    }

    returnPattern.lastIndex = closeIndex + 1;
  }

  return dedupeResponses(responses);
}

function parseResponseObject(objectText) {
  const status = extractNumericProperty(objectText, "status");

  const statusCode = extractStringProperty(objectText, "status_code");

  const ok = extractBooleanProperty(objectText, "ok");

  const message = extractStringProperty(objectText, "message");

  const dataObject = extractPropertyObject(objectText, "data");

  const dataFields = dataObject ? extractObjectKeys(dataObject) : [];

  /*
   * Don't create a response record for arbitrary objects that merely
   * happen to be returned unless they look like a standard API response.
   */
  if (status == null && !statusCode && ok == null && !message && !dataObject) {
    return null;
  }

  return {
    status,
    status_code: statusCode,
    ok,
    meaning: message,
    data: dataFields,
  };
}

function dedupeResponses(responses) {
  const seen = new Set();
  const result = [];

  for (const response of responses) {
    const key = JSON.stringify(response);

    if (seen.has(key)) continue;

    seen.add(key);
    result.push(response);
  }

  return result;
}

/* -------------------------------------------------------------------------- */
/* Response data                                                              */
/* -------------------------------------------------------------------------- */

function extractResponseDataFields(source) {
  const fields = new Set();

  const returnPattern = /\breturn\s*(?=\{)/g;

  let match;

  while ((match = returnPattern.exec(source))) {
    const openIndex = source.indexOf("{", match.index);

    if (openIndex === -1) continue;

    const closeIndex = findMatchingClose(source, openIndex, "{", "}");

    if (closeIndex === -1) continue;

    const objectText = source.slice(openIndex + 1, closeIndex);

    const dataObject = extractPropertyObject(objectText, "data");

    if (dataObject) {
      for (const field of extractObjectKeys(dataObject)) {
        fields.add(field);
      }
    }

    returnPattern.lastIndex = closeIndex + 1;
  }

  return [...fields];
}

function extractObjectKeys(objectText) {
  const entries = splitTopLevelEntries(objectText);
  const fields = [];

  for (const entry of entries) {
    const trimmed = entry.trim();

    if (!trimmed) continue;

    /*
     * key: value
     * "key": value
     * 'key': value
     * `key`: value
     */
    const keyMatch = trimmed.match(
      /^(?:"([^"]+)"|'([^']+)'|`([^`]+)`|([A-Za-z_$][\w$]*))\s*:/,
    );

    if (keyMatch) {
      fields.push(keyMatch[1] ?? keyMatch[2] ?? keyMatch[3] ?? keyMatch[4]);

      continue;
    }

    /*
     * Shorthand:
     *
     * {
     *   user,
     *   token
     * }
     */
    const shorthandMatch = trimmed.match(/^([A-Za-z_$][\w$]*)$/);

    if (shorthandMatch) {
      fields.push(shorthandMatch[1]);
    }
  }

  return fields;
}

/* -------------------------------------------------------------------------- */
/* Error / response properties                                                */
/* -------------------------------------------------------------------------- */

function extractNumericProperty(source, property) {
  const escaped = escapeRegExp(property);

  const pattern = new RegExp(`\\b${escaped}\\s*:\\s*(-?\\d+)`);

  const match = source.match(pattern);

  if (!match) return null;

  return Number(match[1]);
}

function extractStringProperty(source, property) {
  const escaped = escapeRegExp(property);

  const pattern = new RegExp(`\\b${escaped}\\s*:\\s*(['"\`])([\\s\\S]*?)\\1`);

  const match = source.match(pattern);

  if (!match) return null;

  return unescapeSimpleString(match[2]);
}

function extractBooleanProperty(source, property) {
  const escaped = escapeRegExp(property);

  const pattern = new RegExp(`\\b${escaped}\\s*:\\s*(true|false)\\b`);

  const match = source.match(pattern);

  if (!match) return null;

  return match[1] === "true";
}

function extractPropertyObject(source, property) {
  const escaped = escapeRegExp(property);

  const pattern = new RegExp(`\\b${escaped}\\s*:\\s*\\{`);

  const match = pattern.exec(source);

  if (!match) return null;

  const openIndex = match.index + match[0].lastIndexOf("{");

  const closeIndex = findMatchingClose(source, openIndex, "{", "}");

  if (closeIndex === -1) return null;

  return source.slice(openIndex + 1, closeIndex);
}

/* -------------------------------------------------------------------------- */
/* External services                                                          */
/* -------------------------------------------------------------------------- */

function extractExternalServiceCalls(source) {
  const services = [];
  const varToService = {};

  /*
   * Supports:
   *
   * const stripe = await services("stripe");
   * let stripe = await services("stripe");
   * var stripe = services("stripe");
   */
  const serviceVarPattern =
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?services\s*\(\s*(['"`])([^'"`]+)\2\s*\)/g;

  let match;

  while ((match = serviceVarPattern.exec(source))) {
    varToService[match[1]] = match[3];
  }

  /*
   * Also support:
   *
   * const service = await services("stripe");
   *
   * followed by:
   *
   * service.call("charges.create", {...})
   */
  const callPattern = /\b([A-Za-z_$][\w$]*)\s*\.\s*call\s*\(/g;

  while ((match = callPattern.exec(source))) {
    const variable = match[1];

    const serviceName = varToService[variable];

    if (!serviceName) continue;

    const openParenIndex = source.indexOf("(", match.index);

    if (openParenIndex === -1) continue;

    const closeParenIndex = findMatchingClose(source, openParenIndex, "(", ")");

    if (closeParenIndex === -1) continue;

    const argumentsText = source.slice(openParenIndex + 1, closeParenIndex);

    const args = splitTopLevelEntries(argumentsText);

    const method = parseStringLiteral(args[0]);

    if (!method) continue;

    const context = buildServiceContext(args.slice(1));

    services.push({
      service: serviceName,
      method,
      context,
      arguments: args.slice(1).map((arg) => arg.trim()),
    });

    callPattern.lastIndex = closeParenIndex + 1;
  }

  /*
   * Also support direct service calls:
   *
   * await services("stripe").call("charges.create", {...})
   */
  const directPattern =
    /\b(?:await\s+)?services\s*\(\s*(['"`])([^'"`]+)\1\s*\)\s*\.\s*call\s*\(/g;

  while ((match = directPattern.exec(source))) {
    const serviceName = match[2];

    const openParenIndex = source.indexOf("(", match.index);

    if (openParenIndex === -1) continue;

    const closeParenIndex = findMatchingClose(source, openParenIndex, "(", ")");

    if (closeParenIndex === -1) continue;

    const argumentsText = source.slice(openParenIndex + 1, closeParenIndex);

    const args = splitTopLevelEntries(argumentsText);

    const method = parseStringLiteral(args[0]);

    if (!method) continue;

    services.push({
      service: serviceName,
      method,
      context: buildServiceContext(args.slice(1)),
      arguments: args.slice(1).map((arg) => arg.trim()),
    });

    directPattern.lastIndex = closeParenIndex + 1;
  }

  return dedupeServices(services);
}

function buildServiceContext(args) {
  if (!args || args.length === 0) {
    return null;
  }

  const meaningful = args.map((arg) => arg.trim()).filter(Boolean);

  if (meaningful.length === 0) {
    return null;
  }

  const first = meaningful[0];

  /*
   * Object argument:
   *
   * {
   *   amount,
   *   currency: "usd",
   *   customer: user._id
   * }
   */
  if (first.startsWith("{")) {
    const fields = extractObjectKeys(first.slice(1, first.lastIndexOf("}")));

    if (fields.length) {
      return `Arguments: ${fields.map((field) => `\`${field}\``).join(", ")}`;
    }
  }

  /*
   * Generic argument context.
   */
  return `Arguments: ${meaningful
    .map((arg) => {
      const shortened = arg.replace(/\s+/g, " ").trim();

      return `\`${shortened}\``;
    })
    .join(", ")}`;
}

function dedupeServices(services) {
  const seen = new Set();
  const result = [];

  for (const service of services) {
    const key = JSON.stringify({
      service: service.service,
      method: service.method,
      context: service.context,
    });

    if (seen.has(key)) continue;

    seen.add(key);
    result.push(service);
  }

  return result;
}

/* -------------------------------------------------------------------------- */
/* String helpers                                                             */
/* -------------------------------------------------------------------------- */

function parseStringLiteral(text) {
  if (!text) return null;

  const t = text.trim();

  if (t.length < 2) return null;

  const first = t[0];
  const last = t[t.length - 1];

  if ((first === '"' || first === "'" || first === "`") && first === last) {
    return unescapeSimpleString(t.slice(1, -1));
  }

  return null;
}

function unescapeSimpleString(value) {
  return value
    .replace(/\\(["'`\\])/g, "$1")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* -------------------------------------------------------------------------- */
/* Balanced parsing                                                           */
/* -------------------------------------------------------------------------- */

function findMatchingClose(source, openIndex, openChar = "{", closeChar = "}") {
  let depth = 0;
  let inString = null;

  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i];

    if (inString) {
      if (ch === "\\") {
        i++;
        continue;
      }

      if (ch === inString) {
        inString = null;
      }

      continue;
    }

    if (ch === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);

      if (end === -1) break;

      i = end;

      continue;
    }

    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);

      if (end === -1) break;

      i = end + 1;

      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }

    if (ch === openChar) {
      depth++;
    }

    if (ch === closeChar) {
      depth--;

      if (depth === 0) {
        return i;
      }
    }
  }

  return -1;
}

function skipString(source, start) {
  const quote = source[start];

  let i = start + 1;

  while (i < source.length) {
    if (source[i] === "\\") {
      i += 2;
      continue;
    }

    if (source[i] === quote) {
      return i + 1;
    }

    i++;
  }

  return i;
}

/* -------------------------------------------------------------------------- */
/* Top-level splitting                                                        */
/* -------------------------------------------------------------------------- */

function splitTopLevelEntries(text) {
  const entries = [];

  let depth = 0;
  let inString = null;
  let current = "";

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      current += ch;

      if (ch === "\\") {
        current += text[++i] ?? "";
        continue;
      }

      if (ch === inString) {
        inString = null;
      }

      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      current += ch;
      continue;
    }

    if (ch === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);

      if (end === -1) {
        current += text.slice(i);
        break;
      }

      current += text.slice(i, end);
      i = end;

      continue;
    }

    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);

      if (end === -1) {
        current += text.slice(i);
        break;
      }

      current += text.slice(i, end + 2);
      i = end + 1;

      continue;
    }

    if (ch === "{" || ch === "(" || ch === "[") {
      depth++;
    }

    if (ch === "}" || ch === ")" || ch === "]") {
      depth--;
    }

    if (ch === "," && depth === 0) {
      entries.push(current);
      current = "";
      continue;
    }

    current += ch;
  }

  if (current.trim()) {
    entries.push(current);
  }

  return entries;
}
