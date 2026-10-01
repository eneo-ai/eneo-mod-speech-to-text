// Resolve the same source aliases as Next in the compiled component tests.
const Module = require("node:module");
const path = require("node:path");
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  const args = [parent, ...rest];
  // A stylesheet is not compiled: it lies in the source tree, beside the source of the file that imports it.
  if (request.endsWith(".css") && request.startsWith(".") && parent?.filename) {
    request = path.resolve(path.dirname(parent.filename).replace(`${path.sep}.test-build${path.sep}`, path.sep), request);
  }
  if (request.startsWith("@/")) {
    // Compiled sources first; a generated module that is not compiled (the built theme) from where it lies.
    try {
      return resolve.call(this, path.join(__dirname, "../.test-build", request.slice(2)), ...args);
    } catch {
      request = path.join(__dirname, "..", request.slice(2));
    }
  }
  return resolve.call(this, request, ...args);
};

// A stylesheet a component imports (a CSS Module) is its class names as written; the styles are the browser's. tsc
// does not emit the file, so it is answered before it is resolved.
const stylesheet = new Proxy({}, { get: (_, name) => (name === "__esModule" ? false : String(name)) });
const load = Module._load;
Module._load = function (request, ...args) {
  return request.endsWith(".css") ? stylesheet : load.call(this, request, ...args);
};
