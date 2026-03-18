import type { WideEventSamplingDecision } from "#src/types.js";

export type EventFilterPattern = string | RegExp;

export interface IncludeExcludeOptions {
  include?: EventFilterPattern[];
  exclude?: EventFilterPattern[];
  targetName?: string;
}

function escapeRegex(value: string): string {
  return value.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

function globToRegExp(pattern: string): RegExp {
  const placeholder = "__WIDE_EVENT_DOUBLE_STAR__";
  const escaped = escapeRegex(pattern.replaceAll("**", placeholder));
  const regexSource = escaped
    .replaceAll(placeholder, ".*")
    .replaceAll("*", "[^/]*");
  return new RegExp(`^${regexSource}$`);
}

function matchesPattern(value: string, pattern: EventFilterPattern): boolean {
  if (pattern instanceof RegExp) {
    return pattern.test(value);
  }

  return globToRegExp(pattern).test(value);
}

function formatPattern(pattern: EventFilterPattern): string {
  return pattern instanceof RegExp ? pattern.toString() : pattern;
}

function matchAny(value: string, patterns: EventFilterPattern[]): EventFilterPattern | undefined {
  for (const pattern of patterns) {
    if (matchesPattern(value, pattern)) {
      return pattern;
    }
  }

  return undefined;
}

export function normalizePath(path: string): string {
  const queryIndex = path.indexOf("?");
  if (queryIndex === -1) {
    return path;
  }

  return path.slice(0, queryIndex);
}

export function normalizeAdapterFilterResult(
  filterResult: boolean | WideEventSamplingDecision | undefined,
  targetName: string
): WideEventSamplingDecision | undefined {
  if (filterResult === undefined) {
    return undefined;
  }

  if (typeof filterResult === "boolean") {
    return {
      sampled: filterResult,
      reason: filterResult ? `${targetName}_filter_keep` : `${targetName}_filter_drop`
    };
  }

  return filterResult;
}

export function resolveIncludeExcludeDecision(
  value: string,
  options: IncludeExcludeOptions
): WideEventSamplingDecision | undefined {
  const targetName = options.targetName ?? "event";

  if (options.include && options.include.length > 0) {
    const includePattern = matchAny(value, options.include);
    if (!includePattern) {
      return {
        sampled: false,
        reason: `${targetName}_not_included`,
        rule: `include:${options.include.map((pattern) => formatPattern(pattern)).join(",")}`
      };
    }
  }

  if (options.exclude && options.exclude.length > 0) {
    const excludePattern = matchAny(value, options.exclude);
    if (excludePattern) {
      return {
        sampled: false,
        reason: `${targetName}_excluded`,
        rule: `exclude:${formatPattern(excludePattern)}`
      };
    }
  }

  return undefined;
}
