function getLocation(source, index) {
  const before = source.slice(0, index);
  const lines = before.split(/\r\n|\r|\n/);

  return {
    line: lines.length,
    column: lines[lines.length - 1].length,
  };
}

function normalizeJsonError(error, source) {
  if (!(error instanceof SyntaxError)) {
    throw error;
  }

  const match = /position (\d+)/u.exec(error.message);
  if (match) {
    const position = Number(match[1]);
    const loc = getLocation(source, position);

    error.lineNumber = loc.line;
    error.column = loc.column + 1;
  }

  return error;
}

const parser = {
  meta: {
    name: "json-parse-eslint-parser",
    version: "1.0.0",
  },
  parseForESLint(source) {
    try {
      JSON.parse(source);
    } catch (error) {
      throw normalizeJsonError(error, source);
    }

    return {
      ast: {
        type: "Program",
        body: [],
        sourceType: "script",
        range: [0, source.length],
        loc: {
          start: { line: 1, column: 0 },
          end: getLocation(source, source.length),
        },
        tokens: [],
        comments: [],
      },
      scopeManager: null,
      visitorKeys: {
        Program: ["body"],
      },
    };
  },
};

export default parser;
