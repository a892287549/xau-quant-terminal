import * as cheerio from "cheerio";
import { logger } from "../logger.js";

const CACHE_KEY = "event_calendar_cache";
const FED_FOMC_URL = "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm";
const MONTHS = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12
};

function addMinutes(value, minutes) {
  return new Date(new Date(value).getTime() + minutes * 60 * 1000);
}

function iso(value) {
  return new Date(value).toISOString();
}

function uniqueEvents(events = []) {
  const seen = new Set();
  return events
    .filter((event) => event?.at)
    .sort((a, b) => new Date(a.at) - new Date(b.at))
    .filter((event) => {
      const key = `${event.code}:${event.at}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function zonedTimeToUtc({ year, month, day, hour, minute = 0, timeZone = "America/New_York" }) {
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let guess = new Date(target);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });
  for (let index = 0; index < 3; index += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(guess).map((part) => [part.type, part.value]));
    const localAsUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute)
    );
    guess = new Date(guess.getTime() - (localAsUtc - target));
  }
  return guess;
}

function parseMeetingEndDay(text = "") {
  const cleaned = String(text).replace("*", "").trim();
  const range = cleaned.match(/(\d{1,2})\s*-\s*(\d{1,2})/);
  if (range) return Number(range[2]);
  const single = cleaned.match(/\d{1,2}/);
  return single ? Number(single[0]) : null;
}

export function parseFomcCalendar(html, { years = [] } = {}) {
  const selectedYears = new Set(years.map(Number).filter(Boolean));
  const $ = cheerio.load(html || "");
  const events = [];
  $("h4").each((_, heading) => {
    const title = $(heading).text().replace(/\s+/g, " ").trim();
    const match = title.match(/\b(20\d{2})\s+FOMC Meetings\b/i);
    if (!match) return;
    const year = Number(match[1]);
    if (selectedYears.size && !selectedYears.has(year)) return;
    const panel = $(heading).closest(".panel");
    panel.find(".fomc-meeting").each((__, row) => {
      const monthName = $(row).find(".fomc-meeting__month").text().trim().toLowerCase();
      const month = MONTHS[monthName];
      const day = parseMeetingEndDay($(row).find(".fomc-meeting__date").text());
      if (!month || !day) return;
      const at = zonedTimeToUtc({ year, month, day, hour: 14 });
      events.push({
        code: "FOMC",
        name: "FOMC rate decision",
        at: iso(at),
        source: "federalreserve.gov",
        severity: "high"
      });
    });
  });
  return uniqueEvents(events);
}

function observedHolidayDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay();
  if (weekday === 6) date.setUTCDate(date.getUTCDate() - 1);
  if (weekday === 0) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function isMajorObservedHoliday(date) {
  const year = date.getUTCFullYear();
  const day = date.toISOString().slice(0, 10);
  return [
    observedHolidayDate(year, 1, 1),
    observedHolidayDate(year, 7, 4),
    observedHolidayDate(year, 12, 25)
  ].includes(day);
}

function firstFriday(year, month) {
  const date = new Date(Date.UTC(year, month - 1, 1));
  while (date.getUTCDay() !== 5) date.setUTCDate(date.getUTCDate() + 1);
  return date;
}

function nfpReleaseDate(year, month) {
  const date = firstFriday(year, month);
  if (!isMajorObservedHoliday(date)) return date;
  if (month === 1 && date.getUTCDate() <= 2) {
    date.setUTCDate(date.getUTCDate() + 7);
  } else {
    date.setUTCDate(date.getUTCDate() - 1);
  }
  return date;
}

export function generateNfpEvents({ from = new Date(), months = 18 } = {}) {
  const start = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  const events = [];
  for (let offset = 0; offset < months; offset += 1) {
    const base = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + offset, 1));
    const release = nfpReleaseDate(base.getUTCFullYear(), base.getUTCMonth() + 1);
    const at = zonedTimeToUtc({
      year: release.getUTCFullYear(),
      month: release.getUTCMonth() + 1,
      day: release.getUTCDate(),
      hour: 8,
      minute: 30
    });
    events.push({
      code: "NFP",
      name: "US Employment Situation",
      at: iso(at),
      source: "generated_nfp_schedule",
      severity: "high"
    });
  }
  return uniqueEvents(events);
}

export function activeEventWindow(events = [], settings = {}, now = new Date()) {
  const config = settings?.daemon?.eventCalendar || {};
  const defaultBefore = Number(config.beforeMinutes ?? 30);
  const defaultAfter = Number(config.afterMinutes ?? 30);
  const time = new Date(now).getTime();
  return events.find((event) => {
    const at = new Date(event.at).getTime();
    if (Number.isNaN(at)) return false;
    const before = Number(event.beforeMinutes ?? defaultBefore);
    const after = Number(event.afterMinutes ?? defaultAfter);
    return time >= at - before * 60 * 1000 && time <= at + after * 60 * 1000;
  }) || null;
}

function manualEvents(settings = {}) {
  return (settings?.daemon?.eventWindows || []).map((item, index) => ({
    code: item.code || item.type || "MANUAL",
    name: item.name || item.label || "Manual event window",
    at: item.at || item.time || item,
    source: "manual",
    severity: item.severity || "high",
    beforeMinutes: item.beforeMinutes,
    afterMinutes: item.afterMinutes,
    id: item.id || `manual-${index}`
  }));
}

export class EventCalendar {
  constructor({ storage = null, fetchImpl = fetch, now = () => new Date() } = {}) {
    this.storage = storage;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.cache = null;
    this.lastError = "";
  }

  status() {
    return {
      events: this.cache?.events?.length || 0,
      fetchedAt: this.cache?.fetchedAt || null,
      lastError: this.lastError
    };
  }

  async readCache() {
    if (this.cache) return this.cache;
    const saved = await this.storage?.readConfig?.(CACHE_KEY);
    if (saved?.events) this.cache = saved;
    return this.cache;
  }

  async writeCache(cache) {
    this.cache = cache;
    await this.storage?.writeConfig?.(CACHE_KEY, cache).catch((error) => {
      logger.warn({ module: "eventCalendar", error: error.message }, "event calendar cache write failed");
    });
  }

  async fetchFomcEvents(settings = {}) {
    const years = [this.now().getUTCFullYear(), this.now().getUTCFullYear() + 1];
    const response = await this.fetchImpl(FED_FOMC_URL, {
      headers: { "User-Agent": "xau-quant-terminal/1.0" }
    });
    if (!response.ok) throw new Error(`FOMC calendar HTTP ${response.status}`);
    const html = await response.text();
    return parseFomcCalendar(html, { years });
  }

  async refresh(settings = {}) {
    const config = settings?.daemon?.eventCalendar || {};
    const sources = config.sources || {};
    const events = [];
    if (sources.fomc !== false) events.push(...await this.fetchFomcEvents(settings));
    if (sources.nfp !== false) events.push(...generateNfpEvents({ from: this.now(), months: 18 }));
    const cache = {
      fetchedAt: this.now().toISOString(),
      events: uniqueEvents(events)
    };
    await this.writeCache(cache);
    this.lastError = "";
    return cache;
  }

  async getSnapshot(settings = {}) {
    const config = settings?.daemon?.eventCalendar || {};
    if (config.enabled === false) {
      const events = manualEvents(settings);
      return {
        enabled: false,
        events,
        active: activeEventWindow(events, settings, this.now()),
        fetchedAt: null,
        lastError: ""
      };
    }
    const refreshHours = Number(config.refreshIntervalHours || 12);
    const cache = await this.readCache();
    const stale = !cache?.fetchedAt || (this.now() - new Date(cache.fetchedAt)) > refreshHours * 60 * 60 * 1000;
    let current = cache;
    if (stale) {
      try {
        current = await this.refresh(settings);
      } catch (error) {
        this.lastError = error.message;
        logger.warn({ module: "eventCalendar", error: error.message }, "event calendar refresh failed");
      }
    }
    const events = uniqueEvents([...(current?.events || []), ...manualEvents(settings)]);
    return {
      enabled: true,
      events,
      active: activeEventWindow(events, settings, this.now()),
      fetchedAt: current?.fetchedAt || null,
      lastError: this.lastError
    };
  }
}
