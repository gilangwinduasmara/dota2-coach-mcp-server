'use strict';

/**
 * Core Dota 2 match analysis: fetch from OpenDota, cache locally, and build a
 * compact JSON summary tailored for coaching analysis (benchmarks vs.
 * bracket, laning, objectives, teamfights, and an optional deep-dive on one
 * player). Shared by the CLI script (skills/dota2-coach/scripts/analyze_match.js)
 * and the MCP server (mcp-server/server.js) so both stay in sync.
 */

const fs = require('fs');
const path = require('path');
const { getJson, requestAndWaitForParse } = require('./opendota');
const { getHeroes, getItemIds, getItems, getGameModes, getLobbyTypes, getAbilityIds, getAbilities } = require('./constants');
const { mmss, prettyHeroKey, prettyBuildingKey, LANE_ROLE_NAMES, titleCaseKey, prettyRuneKey, prettyRankTier } = require('./format');
const { BASE_CACHE_DIR: CACHE_DIR } = require('./cache-dir');

class AnalyzeError extends Error {
  constructor(message, { candidates } = {}) {
    super(message);
    this.name = 'AnalyzeError';
    if (candidates) this.candidates = candidates;
  }
}

function isParsed(match) {
  return typeof match.version === 'number' && Array.isArray(match.objectives);
}

async function loadMatch(matchId, { refresh, noWait, onProgress } = {}) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cacheFile = path.join(CACHE_DIR, `${matchId}.json`);
  const progress = onProgress || (() => {});

  let match = null;
  if (!refresh && fs.existsSync(cacheFile)) {
    match = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  }

  if (!match) {
    match = await getJson(`/matches/${matchId}`);
    if (match.__notFound) {
      if (noWait) {
        throw new AnalyzeError(
          `Match ${matchId} was not found on OpenDota. It may not exist, be a private/bot lobby match, ` +
            `or simply hasn't been indexed yet. Try again shortly, or omit --no-wait to let this script request it.`
        );
      }
      progress(`Match ${matchId} not in OpenDota yet; requesting it from Steam...`);
      await requestAndWaitForParse(matchId);
      match = await getJson(`/matches/${matchId}`);
      if (match.__notFound) {
        throw new AnalyzeError(
          `Match ${matchId} still not found after requesting it. It likely does not exist, is not a ` +
            `public/trackable match, or is too old for the replay to still be available.`
        );
      }
    }
  }

  if (!isParsed(match) && !noWait) {
    progress(`Match ${matchId} has no detailed parse yet; requesting a full parse (this can take ~30-90s)...`);
    const done = await requestAndWaitForParse(matchId, { timeoutMs: 120000, intervalMs: 8000 });
    if (done) {
      const reparsed = await getJson(`/matches/${matchId}`);
      if (!reparsed.__notFound) match = reparsed;
    } else {
      progress('Parse job did not finish in time; continuing with basic (unparsed) stats.');
    }
  }

  fs.writeFileSync(cacheFile, JSON.stringify(match));
  return match;
}

function resolveHeroName(heroesById, heroId) {
  const h = heroesById.get(heroId);
  return h ? h.localized_name : `Hero #${heroId}`;
}

function resolveItemName(itemIds, items, numericId) {
  if (!numericId) return null;
  const internal = itemIds[String(numericId)];
  if (!internal) return null;
  const meta = items[internal];
  return meta ? meta.dname : internal;
}

function playerItems(p, itemIds, items) {
  const slots = [p.item_0, p.item_1, p.item_2, p.item_3, p.item_4, p.item_5];
  const neutral = p.item_neutral;
  return {
    inventory: slots.map((id) => resolveItemName(itemIds, items, id)).filter(Boolean),
    neutral: resolveItemName(itemIds, items, neutral),
    backpack: [p.backpack_0, p.backpack_1, p.backpack_2].map((id) => resolveItemName(itemIds, items, id)).filter(Boolean),
  };
}

function resolveAbilityName(abilityIds, abilities, numericId) {
  if (!numericId) return null;
  const internal = abilityIds[String(numericId)];
  if (!internal) return `Ability #${numericId}`;
  const meta = abilities[internal];
  return meta ? meta.dname : titleCaseKey(internal);
}

// item_uses/ability_uses/damage_inflictor are keyed by internal name, not
// numeric id, and mix real items, abilities, and shard/scepter-upgraded
// ability variants (e.g. "arcane_blink") that may not be in either dict.
function resolveInternalKeyName(internalKey, abilities, items) {
  if (internalKey === 'null' || internalKey === null) return 'Basic attacks / other';
  const ability = abilities[internalKey];
  if (ability) return ability.dname;
  const item = items[internalKey];
  if (item) return item.dname;
  return titleCaseKey(internalKey);
}

// Sums rather than overwrites when multiple internal keys resolve to the same
// display name (e.g. a hero's several Shadowraze variants all display as
// "Shadowraze" but are tracked as separate abilities).
function resolveCountMap(counts, abilities, items) {
  if (!counts) return null;
  const out = {};
  for (const [key, count] of Object.entries(counts)) {
    const name = resolveInternalKeyName(key, abilities, items);
    out[name] = (out[name] || 0) + count;
  }
  return out;
}

function skillBuild(p, abilityIds, abilities) {
  if (!Array.isArray(p.ability_upgrades_arr)) return null;
  return p.ability_upgrades_arr.map((id, i) => ({
    level: i + 1,
    ability: resolveAbilityName(abilityIds, abilities, id),
  }));
}

function damageBreakdown(p, abilities, items) {
  if (!p.damage_inflictor) return null;
  const total = Object.values(p.damage_inflictor).reduce((sum, v) => sum + v, 0) || 1;
  const byName = {};
  for (const [key, damage] of Object.entries(p.damage_inflictor)) {
    const name = resolveInternalKeyName(key, abilities, items);
    byName[name] = (byName[name] || 0) + damage;
  }
  return Object.entries(byName)
    .map(([source, damage]) => ({ source, damage, pct_of_hero_damage: Math.round((damage / total) * 100) }))
    .sort((a, b) => b.damage - a.damage);
}

function runeControl(p) {
  if (!Array.isArray(p.runes_log)) return null;
  return p.runes_log.map((r) => ({ time: mmss(r.time), rune: prettyRuneKey(r.key) }));
}

function benchmarkPercentiles(p) {
  if (!p.benchmarks) return null;
  const out = {};
  for (const [metric, v] of Object.entries(p.benchmarks)) {
    out[metric] = v && typeof v.pct_bracket === 'number' ? Math.round(v.pct_bracket * 100) : null;
  }
  return out;
}

function summarizePlayer(p, heroesById, itemIds, items) {
  const hero = resolveHeroName(heroesById, p.hero_id);
  const base = {
    team: p.isRadiant ? 'Radiant' : 'Dire',
    player_slot: p.player_slot,
    account_id: p.account_id ?? null,
    personaname: p.personaname || 'Anonymous',
    hero,
    level: p.level,
    result: p.win === 1 ? 'Win' : 'Loss',
    kills: p.kills,
    deaths: p.deaths,
    assists: p.assists,
    kda_ratio: p.deaths > 0 ? Number(((p.kills + p.assists) / p.deaths).toFixed(2)) : p.kills + p.assists,
    gpm: p.gold_per_min,
    xpm: p.xp_per_min,
    net_worth: p.net_worth,
    last_hits: p.last_hits,
    denies: p.denies,
    hero_damage: p.hero_damage,
    tower_damage: p.tower_damage,
    hero_healing: p.hero_healing,
    items: playerItems(p, itemIds, items),
    benchmark_percentiles_in_bracket: benchmarkPercentiles(p),
    rank_medal: prettyRankTier(p.rank_tier),
  };
  if (typeof p.lane_role !== 'undefined') {
    base.lane = LANE_ROLE_NAMES[p.lane_role] || `Lane #${p.lane_role}`;
    base.is_roaming = !!p.is_roaming;
    base.lane_efficiency_pct = p.lane_efficiency_pct ?? null;
  }
  return base;
}

function sampleEveryNMinutes(arr, times, everyMin = 5) {
  if (!Array.isArray(arr) || !Array.isArray(times)) return [];
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const t = times[i];
    if (t % (everyMin * 60) === 0) out.push({ time: mmss(t), value: arr[i] });
  }
  return out;
}

function deepDivePlayer(p, heroesById, itemIds, items, abilityIds, abilities) {
  const hero = resolveHeroName(heroesById, p.hero_id);
  return {
    hero,
    personaname: p.personaname || 'Anonymous',
    rank_medal: prettyRankTier(p.rank_tier),
    lane: typeof p.lane_role !== 'undefined' ? LANE_ROLE_NAMES[p.lane_role] || `Lane #${p.lane_role}` : null,
    is_roaming: !!p.is_roaming,
    lane_efficiency_pct: p.lane_efficiency_pct ?? null,
    boots_purchase_time:
      p.first_purchase_time && typeof p.first_purchase_time.boots === 'number' ? mmss(p.first_purchase_time.boots) : null,
    teamfight_participation_pct: typeof p.teamfight_participation === 'number' ? Math.round(p.teamfight_participation * 100) : null,
    stuns_seconds: typeof p.stuns === 'number' ? Number(p.stuns.toFixed(1)) : null,
    camps_stacked: p.camps_stacked ?? null,
    obs_wards_placed: p.obs_placed ?? null,
    sentry_wards_placed: p.sen_placed ?? null,
    buyback_count: p.buyback_count ?? null,
    gold_timeline: sampleEveryNMinutes(p.gold_t, p.times),
    xp_timeline: sampleEveryNMinutes(p.xp_t, p.times),
    last_hits_timeline: sampleEveryNMinutes(p.lh_t, p.times),
    net_worth_timeline: sampleEveryNMinutes(p.networth_t, p.times),
    kills_log: (p.kills_log || []).map((k) => ({ time: mmss(k.time), killed: prettyHeroKey(k.key) })),
    deaths_log: (p.deaths_log || []).map((d) => ({
      time: mmss(d.time),
      killed_by: prettyHeroKey(d.key),
      gold_lost: d.gold_lost,
      seconds_dead: d.time_dead,
    })),
    buyback_log: (p.buyback_log || []).map((b) => ({ time: mmss(b.time) })),
    item_purchase_timeline: (p.purchase_log || [])
      .filter((e) => e.time >= 0)
      .map((e) => ({ time: mmss(e.time), item: (items[e.key] && items[e.key].dname) || e.key })),
    multi_kills: p.multi_kills || null,
    kill_streaks: p.kill_streaks || null,
    skill_build: skillBuild(p, abilityIds, abilities),
    rune_control: runeControl(p),
    damage_sources: damageBreakdown(p, abilities, items),
    item_activation_counts: resolveCountMap(p.item_uses, abilities, items),
    ability_cast_counts: resolveCountMap(p.ability_uses, abilities, items),
  };
}

function findFocalPlayer(players, query) {
  if (/^\d+$/.test(query)) {
    const byId = players.filter((p) => String(p.account_id) === query);
    if (byId.length) return byId;
  }
  const q = query.toLowerCase();
  const byName = players.filter((p) => (p.personaname || '').toLowerCase().includes(q));
  if (byName.length) return byName;
  return players.filter((p) => (p.__heroName || '').toLowerCase().includes(q));
}

function objectivesTimeline(match, heroesById) {
  const slotToHero = new Map();
  for (const p of match.players) slotToHero.set(p.player_slot, resolveHeroName(heroesById, p.hero_id));

  return (match.objectives || [])
    .slice()
    .sort((a, b) => a.time - b.time)
    .map((o) => {
      let text;
      switch (o.type) {
        case 'CHAT_MESSAGE_FIRSTBLOOD':
          text = `First blood: ${slotToHero.get(o.player_slot) || 'someone'} killed ${slotToHero.get(o.victim_player_slot) || 'an enemy'}`;
          break;
        case 'building_kill':
          text = `${prettyBuildingKey(o.key)} destroyed${o.player_slot !== undefined ? ` by ${slotToHero.get(o.player_slot) || 'someone'}` : ''}`;
          break;
        case 'CHAT_MESSAGE_ROSHAN_KILL':
          text = `Roshan killed by ${o.team === 2 ? 'Dire' : 'Radiant'}`;
          break;
        case 'CHAT_MESSAGE_AEGIS':
          text = `Aegis picked up by ${slotToHero.get(o.player_slot) || 'someone'}`;
          break;
        case 'CHAT_MESSAGE_COURIER_LOST':
          text = `Courier killed (${o.team === 2 ? 'Dire' : 'Radiant'} courier)`;
          break;
        case 'CHAT_MESSAGE_GLYPH_USED':
          text = `Glyph used by ${o.team === 2 ? 'Dire' : 'Radiant'}`;
          break;
        default:
          text = o.type;
      }
      return { time: mmss(o.time), type: o.type, text };
    });
}

function teamfightsSummary(match) {
  return (match.teamfights || []).map((tf) => {
    let radiantGoldDelta = 0;
    let direGoldDelta = 0;
    tf.players.forEach((tp, slot) => {
      const isRadiant = slot < 5;
      if (isRadiant) radiantGoldDelta += tp.gold_delta || 0;
      else direGoldDelta += tp.gold_delta || 0;
    });
    return {
      start: mmss(tf.start),
      end: mmss(tf.end),
      duration_s: tf.end - tf.start,
      deaths: tf.deaths,
      radiant_gold_delta: radiantGoldDelta,
      dire_gold_delta: direGoldDelta,
    };
  });
}

/**
 * @param {object} opts
 * @param {string|number} opts.matchId
 * @param {string} [opts.player] account_id (exact), personaname (substring, ci), or hero name (substring, ci)
 * @param {boolean} [opts.refresh] bypass cache
 * @param {boolean} [opts.noWait] don't request/wait for a full parse if unparsed
 * @param {boolean} [opts.raw] include the raw cache file path in the result
 * @param {(msg: string) => void} [opts.onProgress] called with human-readable progress notes
 *   (e.g. "requesting a parse, this can take ~90s") while a slow fetch/parse is in flight
 * @returns {Promise<object>} the coaching-report-ready summary
 */
async function analyzeMatch({ matchId, player, refresh, noWait, raw, onProgress } = {}) {
  if (!matchId || !/^\d+$/.test(String(matchId))) {
    throw new AnalyzeError('matchId must be a numeric Dota 2 match id.');
  }
  matchId = String(matchId);

  const [match, heroesById, itemIds, items, gameModes, lobbyTypes, abilityIds, abilities] = await Promise.all([
    loadMatch(matchId, { refresh, noWait, onProgress }),
    getHeroes(),
    getItemIds(),
    getItems(),
    getGameModes(),
    getLobbyTypes(),
    getAbilityIds(),
    getAbilities(),
  ]);

  const parsed = isParsed(match);
  const players = match.players.map((p) => {
    const s = summarizePlayer(p, heroesById, itemIds, items);
    s.__heroName = s.hero;
    return s;
  });

  const summary = {
    match_id: Number(matchId),
    parsed_detail_available: parsed,
    patch: match.patch,
    region: match.region,
    game_mode: (gameModes[match.game_mode] && gameModes[match.game_mode].name) || match.game_mode,
    lobby_type: (lobbyTypes[match.lobby_type] && lobbyTypes[match.lobby_type].name) || match.lobby_type,
    duration: mmss(match.duration),
    duration_seconds: match.duration,
    result: match.radiant_win ? 'Radiant Win' : 'Dire Win',
    radiant_score: match.radiant_score,
    dire_score: match.dire_score,
    first_blood_time: typeof match.first_blood_time === 'number' ? mmss(match.first_blood_time) : null,
    comeback_gold: typeof match.comeback === 'number' ? match.comeback : null,
    stomp_gold: typeof match.stomp === 'number' ? match.stomp : null,
    draft: (match.picks_bans || []).map((pb) => ({
      team: pb.team === 0 ? 'Radiant' : 'Dire',
      action: pb.is_pick ? 'pick' : 'ban',
      hero: resolveHeroName(heroesById, pb.hero_id),
      order: pb.order,
    })),
    players: players.map(({ __heroName, ...rest }) => rest),
  };

  if (parsed) {
    summary.gold_advantage_timeline_radiant = sampleEveryNMinutes(match.radiant_gold_adv, match.players[0].times, 5);
    summary.xp_advantage_timeline_radiant = sampleEveryNMinutes(match.radiant_xp_adv, match.players[0].times, 5);
    summary.objectives_timeline = objectivesTimeline(match, heroesById);
    summary.teamfights = teamfightsSummary(match);
  } else {
    summary.note =
      'This match only has basic stats (no full parse available/completed). Laning, objectives, teamfights, ' +
      'and timelines are unavailable; analysis should rely on final KDA, GPM/XPM, net worth, and benchmark percentiles.';
  }

  if (player) {
    const candidates = findFocalPlayer(match.players.map((p, i) => ({ ...p, __heroName: players[i].hero })), player);
    if (candidates.length === 0) {
      throw new AnalyzeError(
        `No player matched "${player}". Available: ${players.map((p) => `${p.personaname} (${p.hero})`).join(', ')}`
      );
    } else if (candidates.length > 1) {
      throw new AnalyzeError(
        `"${player}" is ambiguous, matched ${candidates.length} players: ` +
          candidates.map((p) => `${p.personaname} (${p.__heroName}, account_id=${p.account_id})`).join(', ') +
          '. Re-run with a more specific player value (account_id is unambiguous).',
        { candidates: candidates.map((p) => ({ personaname: p.personaname, hero: p.__heroName, account_id: p.account_id })) }
      );
    }
    const focal = candidates[0];
    summary.players.find((p) => p.player_slot === focal.player_slot).is_focal = true;
    if (parsed) {
      summary.focal_player_deep_dive = deepDivePlayer(focal, heroesById, itemIds, items, abilityIds, abilities);
    } else {
      summary.focal_player_deep_dive = { note: 'No parsed data available for a deep dive; see basic stats in players[].' };
    }
  }

  if (raw) {
    summary.raw_match_json_path = path.join(CACHE_DIR, `${matchId}.json`);
  }

  return summary;
}

module.exports = { analyzeMatch, AnalyzeError, CACHE_DIR };
