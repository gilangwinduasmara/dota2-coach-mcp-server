'use strict';

const path = require('path');

// Overridable so a bundled build (where __dirname no longer reflects the
// source tree) or a plugin host (which wants cache under its own persistent
// data dir, not its install dir) can redirect it. Falls back to a `cache/`
// folder next to this repo's lib/ for local/CLI use.
const BASE_CACHE_DIR = process.env.DOTA2_COACH_CACHE_DIR
  ? path.resolve(process.env.DOTA2_COACH_CACHE_DIR)
  : path.join(__dirname, '..', 'cache');

module.exports = { BASE_CACHE_DIR };
