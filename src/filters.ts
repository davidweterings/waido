export type EventFilterPattern = string | RegExp;

export interface IncludeExcludeOptions {
  include?: EventFilterPattern[];
  exclude?: EventFilterPattern[];
}

function escapeRegex(value: string): string {
  return value.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

function globToRegExp(pattern: string): RegExp {
  const placeholder = "__WIDE_EVENT_DOUBLE_STAR__";
  const escaped = escapeRegex(pattern.replaceAll("**", placeholder));
  const regexSource = escaped.replaceAll(placeholder, ".*").replaceAll("*", "[^/]*");
  return new RegExp(`^${regexSource}$`);
}

function compile(pattern: EventFilterPattern): RegExp {
  if (typeof pattern === "string") {
    return globToRegExp(pattern);
  }

  // A `g` or `y` flag would make repeated `test()` calls depend on the previous match.
  return new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ""));
}

export function normalizePath(path: string): string {
  const queryIndex = path.indexOf("?");
  return queryIndex === -1 ? path : path.slice(0, queryIndex);
}

/** Returns a matcher answering whether a path should be captured. */
export function createPathMatcher(options: IncludeExcludeOptions): (path: string) => boolean {
  const include = options.include?.map(compile) ?? [];
  const exclude = options.exclude?.map(compile) ?? [];

  return (path) => {
    if (include.length > 0 && !include.some((pattern) => pattern.test(path))) {
      return false;
    }

    return !exclude.some((pattern) => pattern.test(path));
  };
}
