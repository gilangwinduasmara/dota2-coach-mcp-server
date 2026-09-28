'use strict';

const fs = require('fs');
const path = require('path');
const { getJson } = require('./opendota');
const { BASE_CACHE_DIR } = require('./cache-dir');

const CACHE_DIR = path.join(BASE_CACHE_DIR, 'constants');
const TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

function cachePath(name) {
  return path.join(CACHE_DIR, `${name}.json`);
}

async function loadConstant(name, apiPath) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const file = cachePath(name);

  if (fs.existsSync(file)) {
    const age = Date.now() - fs.statSync(file).mtimeMs;
    if (age < TTL_MS) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  }

  try {
    const data = await getJson(apiPath);
    fs.writeFileSync(file, JSON.stringify(data));
    return data;
  } catch (err) {
    if (fs.existsSync(file)) {
      // Network hiccup or rate limit: fall back to stale cache rather than fail outright.
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    throw err;
  }
}

async function getHeroes() {
  const list = await loadConstant('heroes', '/heroes');
  const byId = new Map();
  for (const h of list) byId.set(h.id, h);
  return byId;
}

async function getItemIds() {
  // numeric item id (string) -> internal item name
  return loadConstant('item_ids', '/constants/item_ids');
}

async function getItems() {
  // internal item name -> item detail (dname, cost, ...)
  return loadConstant('items', '/constants/items');
}

async function getGameModes() {
  return loadConstant('game_mode', '/constants/game_mode');
}

async function getLobbyTypes() {
  return loadConstant('lobby_type', '/constants/lobby_type');
}

async function getAbilityIds() {
  // numeric ability id (string) -> internal ability name
  return loadConstant('ability_ids', '/constants/ability_ids');
}

async function getAbilities() {
  // internal ability name -> ability detail (dname, behavior, desc, ...)
  return loadConstant('abilities', '/constants/abilities');
}

module.exports = { getHeroes, getItemIds, getItems, getGameModes, getLobbyTypes, getAbilityIds, getAbilities };
