'use strict';

function mmss(seconds) {
  const s = Math.round(seconds);
  const sign = s < 0 ? '-' : '';
  const abs = Math.abs(s);
  const m = Math.floor(abs / 60);
  const r = abs % 60;
  return `${sign}${m}:${String(r).padStart(2, '0')}`;
}

// npc_dota_hero_phantom_lancer -> Phantom Lancer (fallback when hero lookup misses)
function prettyHeroKey(key) {
  if (!key) return key;
  return key
    .replace(/^npc_dota_hero_/, '')
    .split('_')
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

const BUILDING_NAMES = {
  tower1: 'Tier 1 Tower',
  tower2: 'Tier 2 Tower',
  tower3: 'Tier 3 Tower',
  tower4: 'Tier 4 (base) Tower',
  melee_rax: 'Melee Barracks',
  range_rax: 'Ranged Barracks',
  fort: 'Ancient',
};

const LANE_NAMES = { top: 'Top', mid: 'Mid', bot: 'Bottom' };

// npc_dota_goodguys_tower1_top -> "Radiant Top Tier 1 Tower"
function prettyBuildingKey(key) {
  if (!key) return key;
  const side = key.includes('goodguys') ? 'Radiant' : key.includes('badguys') ? 'Dire' : '';
  let rest = key.replace(/^npc_dota_(goodguys|badguys)_/, '');
  const laneMatch = Object.keys(LANE_NAMES).find((l) => rest.endsWith(`_${l}`));
  const lane = laneMatch ? LANE_NAMES[laneMatch] : '';
  if (laneMatch) rest = rest.slice(0, -(laneMatch.length + 1));
  const building = BUILDING_NAMES[rest] || rest;
  return [side, lane, building].filter(Boolean).join(' ');
}

const LANE_ROLE_NAMES = { 1: 'Safe Lane', 2: 'Mid Lane', 3: 'Off Lane', 4: 'Jungle' };

// snake_case internal key -> Title Case, for items/abilities not found in the
// OpenDota constants dicts (e.g. shard-upgraded ability variants like
// "arcane_blink").
function titleCaseKey(key) {
  if (!key) return key;
  return key
    .split('_')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

// DOTA_RUNE_* enum (stable since it's core engine data; not exposed by
// OpenDota's /constants endpoints). Falls back to "Rune #n" for anything new.
const RUNE_NAMES = {
  0: 'Double Damage',
  1: 'Haste',
  2: 'Illusion',
  3: 'Invisibility',
  4: 'Regeneration',
  5: 'Bounty',
  6: 'Arcane',
  7: 'Water/Shield',
  8: 'Shield',
};

function prettyRuneKey(key) {
  return RUNE_NAMES[key] || `Rune #${key}`;
}

// Standard Dota 2 medal tiers. rank_tier is tens-digit medal + ones-digit
// star (e.g. 55 = Divine 5); Immortal (8x) has no meaningful star.
const MEDAL_NAMES = {
  1: 'Herald',
  2: 'Guardian',
  3: 'Crusader',
  4: 'Archon',
  5: 'Legend',
  6: 'Ancient',
  7: 'Divine',
  8: 'Immortal',
};

function prettyRankTier(rankTier) {
  if (!rankTier || typeof rankTier !== 'number') return null;
  const medal = Math.floor(rankTier / 10);
  const star = rankTier % 10;
  const name = MEDAL_NAMES[medal];
  if (!name) return null;
  return medal === 8 || !star ? name : `${name} ${star}`;
}

module.exports = {
  mmss,
  prettyHeroKey,
  prettyBuildingKey,
  LANE_ROLE_NAMES,
  titleCaseKey,
  prettyRuneKey,
  prettyRankTier,
};
