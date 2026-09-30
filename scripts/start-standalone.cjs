const path = require("node:path");

// The generated server changes cwd; resolve the cache before that so local
// development, the production server, and maintenance commands use one directory.
process.env.CELESTRAK_CACHE_DIR ||= path.resolve(__dirname, "..", ".cache", "celestrak");
process.env.HOSTNAME ||= "0.0.0.0";
require(path.resolve(__dirname, "..", ".next", "standalone", "server.js"));
