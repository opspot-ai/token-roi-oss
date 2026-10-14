export function parseJsonStrict(source, { maxDepth = 64 } = {}) {
  if (typeof source !== "string") throw new TypeError("JSON input must be text");
  let index = 0;

  const fail = (message) => {
    throw new SyntaxError(`${message} at character ${index + 1}`);
  };
  const whitespace = () => {
    while (index < source.length && /[\t\n\r ]/.test(source[index])) index += 1;
  };
  const string = () => {
    const start = index;
    if (source[index] !== '"') fail("Expected a JSON string");
    index += 1;
    while (index < source.length) {
      const character = source[index];
      if (character === '"') {
        index += 1;
        try {
          return JSON.parse(source.slice(start, index));
        } catch {
          fail("Invalid JSON string");
        }
      }
      if (character === "\\") {
        index += 2;
        continue;
      }
      if (character.charCodeAt(0) < 0x20) fail("Unescaped control character in JSON string");
      index += 1;
    }
    fail("Unterminated JSON string");
  };
  const value = (depth) => {
    if (depth > maxDepth) fail("JSON nesting limit exceeded");
    whitespace();
    const character = source[index];
    if (character === '"') return string();
    if (character === "{") {
      index += 1;
      whitespace();
      const result = Object.create(null);
      const keys = new Set();
      if (source[index] === "}") {
        index += 1;
        return result;
      }
      while (index < source.length) {
        whitespace();
        if (source[index] !== '"') fail("Expected an object key");
        const key = string();
        if (keys.has(key)) fail(`Duplicate JSON key ${JSON.stringify(key)}`);
        keys.add(key);
        whitespace();
        if (source[index] !== ":") fail("Expected ':' after object key");
        index += 1;
        result[key] = value(depth + 1);
        whitespace();
        if (source[index] === "}") {
          index += 1;
          return result;
        }
        if (source[index] !== ",") fail("Expected ',' or '}'");
        index += 1;
      }
      fail("Unterminated JSON object");
    }
    if (character === "[") {
      index += 1;
      whitespace();
      const result = [];
      if (source[index] === "]") {
        index += 1;
        return result;
      }
      while (index < source.length) {
        result.push(value(depth + 1));
        whitespace();
        if (source[index] === "]") {
          index += 1;
          return result;
        }
        if (source[index] !== ",") fail("Expected ',' or ']'");
        index += 1;
      }
      fail("Unterminated JSON array");
    }
    if (source.startsWith("true", index)) {
      index += 4;
      return true;
    }
    if (source.startsWith("false", index)) {
      index += 5;
      return false;
    }
    if (source.startsWith("null", index)) {
      index += 4;
      return null;
    }
    const number = /^-?(?:0|[1-9]\d*)/.exec(source.slice(index));
    if (number) {
      index += number[0].length;
      const parsed = Number(number[0]);
      if (!Number.isSafeInteger(parsed)) fail("JSON numbers must be safe integers; money belongs in decimal strings");
      return parsed;
    }
    fail("Expected a JSON value");
  };

  const result = value(0);
  whitespace();
  if (index !== source.length) fail("Unexpected trailing JSON content");
  return result;
}
