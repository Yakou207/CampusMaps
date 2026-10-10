// Talks to the Flask API (app.py). Every request carries an anonymous client id so a
// visitor can update their own rating later; the id never leaves this browser otherwise.

const KEY = 'campusmaps-client-id';
let memoryId = null;

function newId() {
  // crypto.randomUUID only exists on https/localhost; getRandomValues works everywhere.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').replace(/(.{8})(.{4})(.{4})(.{4})/, '$1-$2-$3-$4-');
}

export function clientId() {
  try {
    let id = localStorage.getItem(KEY);
    if (!id) {
      id = newId();
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    // storage blocked (private mode): ratings still work, but only for this page visit
    memoryId ||= newId();
    return memoryId;
  }
}

/** Errors carry .errors (field -> message) when the server rejected the input. */
export class ApiError extends Error {
  constructor(message, errors = {}, status = 0) {
    super(message);
    this.errors = errors;
    this.status = status;
  }
}

async function request(path, { method = 'GET', body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Client-Id': clientId() },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch {
    throw new ApiError('网络连接失败，请检查网络后重试 · Network problem — check your connection and try again.');
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errors = data.errors || {};
    throw new ApiError(errors.form || '服务器出错了，请稍后再试 · Something went wrong on our side. Try again shortly.', errors, res.status);
  }
  return data;
}

export const getPlaces = () => request('/api/places');
export const getStallRatings = (stallId) => request(`/api/stalls/${encodeURIComponent(stallId)}/ratings`);
export const saveRating = (stallId, stars, comment) =>
  request('/api/ratings', { method: 'POST', body: { stall_id: stallId, stars, comment } });
export const saveSuggestion = (payload) => request('/api/suggestions', { method: 'POST', body: payload });
