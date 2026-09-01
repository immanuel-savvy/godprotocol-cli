export function extractSchemaObject(routeEntryBodyText) {
  const match = routeEntryBodyText.match(/schema\s*:\s*\{/);
  if (!match) return null;
  const openIndex = match.index + match[0].length - 1;
  const { text } = readBalanced(routeEntryBodyText, openIndex, "{", "}");
  if (text === null) return null;
  return { raw: `{${text}}` };
}

export function evaluateSchema(rawSchemaText) {
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(`"use strict"; return (${rawSchemaText});`);
    return { ok: true, value: fn() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export function describeSchemaSection(sectionRules, pathPrefix = "") {
  const fields = [];
  let logic = null;
  for (const [key, rule] of Object.entries(sectionRules ?? {})) {
    if (key === "$logic") {
      logic = describeLogic(rule);
      continue;
    }
    const fullPath = pathPrefix ? `${pathPrefix}.${key}` : key;
    fields.push({
      field: fullPath,
      type:
        typeof rule.type === "object"
          ? (rule.type?.value ?? "unknown")
          : (rule.type ?? "any"),
      required: !!rule.required,
      default: rule.default_value,
      enum: rule.enum ?? null,
      pattern: rule.pattern ? String(rule.pattern) : null,
      constraints: describeConstraints(rule),
      validator: rule.validator ?? null,
      description: rule.description ?? null,
    });
    if (rule.type === "object" && rule.schema) {
      fields.push(...describeSchemaSection(rule.schema, fullPath).fields);
    }
    if (rule.type === "array" && rule.items) {
      fields.push(
        ...describeSchemaSection({ [`${key}[]`]: rule.items }, pathPrefix)
          .fields,
      );
    }
  }
  return { fields, logic };
}

function describeLogic(logicRule) {
  const result = {};
  if (logicRule.or) result.or = logicRule.or.map(cloneGroup);
  if (logicRule.and) result.and = logicRule.and.map(cloneGroup);
  return result;
}

function cloneGroup(group) {
  const { properties, required, type, ...rest } = group;
  return { properties, required: !!required, type: type ?? null, ...rest };
}

const CONSTRAINT_KEYS = [
  "min",
  "max",
  "gt",
  "gte",
  "lt",
  "lte",
  "eq",
  "ne",
  "minLength",
  "maxLength",
  "length",
];

function describeConstraints(rule) {
  return (
    CONSTRAINT_KEYS.filter((k) => rule[k] !== undefined)
      .map((k) => `${k}: ${rule[k]}`)
      .join(", ") || null
  );
}

function readBalanced(source, openIndex, openChar, closeChar) {
  let depth = 0;
  let inString = null;
  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    // Skip comments so apostrophes in "// customer's ..." don't break matching
    if (ch === "/" && source[i + 1] === "/") {
      i = source.indexOf("\n", i);
      if (i === -1) break;
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
    if (ch === openChar) depth++;
    if (ch === closeChar) {
      depth--;
      if (depth === 0)
        return { text: source.slice(openIndex + 1, i), endIndex: i };
    }
  }
  return { text: null, endIndex: -1 };
}
