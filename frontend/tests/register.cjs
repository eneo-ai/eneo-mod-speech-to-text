// Resolve the same source aliases as Next in the compiled component tests.
const Module = require("node:module");
const path = require("node:path");
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request.startsWith("@/")) request = path.join(__dirname, "../.test-build", request.slice(2));
  return resolve.call(this, request, ...args);
};
