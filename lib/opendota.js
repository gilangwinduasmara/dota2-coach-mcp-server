'use strict';

const BASE = 'https://api.opendota.com/api';

async function getJson(path) {
  const res = await fetch(`${BASE}${path}`);
  if (res.status === 404) return { __notFound: true };
  if (!res.ok) {
    throw new Error(`OpenDota GET ${path} failed: HTTP ${res.status}`);
  }
  return res.json();
}

async function postJson(path) {
  const res = await fetch(`${BASE}${path}`, { method: 'POST' });
  if (!res.ok) {
    throw new Error(`OpenDota POST ${path} failed: HTTP ${res.status}`);
  }
  return res.json();
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Ask OpenDota to (re)parse a match from the replay/GC, then poll the job
 * queue until it drains (job status resolves to null) or timeoutMs elapses.
 * Returns true if the job appears to have finished, false on timeout.
 */
async function requestAndWaitForParse(matchId, { timeoutMs = 90000, intervalMs = 6000 } = {}) {
  const { job } = await postJson(`/request/${matchId}`);
  const jobId = job && job.jobId;
  if (!jobId) return false;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const status = await getJson(`/request/${jobId}`);
    if (status === null) return true; // job drained from queue
  }
  return false;
}

module.exports = { getJson, postJson, requestAndWaitForParse, sleep, BASE };
