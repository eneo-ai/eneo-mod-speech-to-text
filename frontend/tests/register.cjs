// Resolve the same source aliases as Next in the compiled component tests.
const Module = require("node:module");
const path = require("node:path");
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...args) {
  // A stylesheet is not compiled, so it is not in .test-build: it lies beside the source of the file that imports it.
  if (request.startsWith(".") && request.endsWith(".css") && parent?.filename) {
    const from = path.dirname(parent.filename).replace(`${path.sep}.test-build${path.sep}`, path.sep);
    return resolve.call(this, path.resolve(from, request), parent, ...args);
  }
  if (request.startsWith("@/")) {
    // Compiled sources first; a generated module that is not compiled (the built theme) from where it lies.
    try {
      return resolve.call(this, path.join(__dirname, "../.test-build", request.slice(2)), parent, ...args);
    } catch {
      request = path.join(__dirname, "..", request.slice(2));
    }
  }
  return resolve.call(this, request, parent, ...args);
};

// A stylesheet a component imports (a CSS Module) is its class names as written; the styles are the browser's.
require.extensions[".css"] = (module) => {
  module.exports = new Proxy({}, { get: (_, name) => (name === "__esModule" ? false : String(name)) });
};
