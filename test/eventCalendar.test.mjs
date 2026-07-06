import test from "node:test";
import assert from "node:assert/strict";
import { activeEventWindow, generateNfpEvents, parseFomcCalendar } from "../server/monitor/eventCalendar.js";

test("FOMC parser reads official meeting rows and converts ET to UTC", () => {
  const html = `
    <div class="panel panel-default">
      <div class="panel-heading"><h4>2026 FOMC Meetings</h4></div>
      <div class="row fomc-meeting">
        <div class="fomc-meeting__month"><strong>January</strong></div>
        <div class="fomc-meeting__date">27-28</div>
      </div>
      <div class="row fomc-meeting">
        <div class="fomc-meeting__month"><strong>July</strong></div>
        <div class="fomc-meeting__date">28-29</div>
      </div>
    </div>
  `;
  const events = parseFomcCalendar(html, { years: [2026] });
  assert.equal(events.length, 2);
  assert.equal(events[0].at, "2026-01-28T19:00:00.000Z");
  assert.equal(events[1].at, "2026-07-29T18:00:00.000Z");
});

test("NFP generator adjusts Independence Day observed Friday to Thursday", () => {
  const events = generateNfpEvents({ from: new Date("2026-07-01T00:00:00Z"), months: 1 });
  assert.equal(events[0].code, "NFP");
  assert.equal(events[0].at, "2026-07-02T12:30:00.000Z");
});

test("active event window includes configured before and after minutes", () => {
  const event = { code: "FOMC", at: "2026-07-29T18:00:00.000Z" };
  const settings = { daemon: { eventCalendar: { beforeMinutes: 30, afterMinutes: 15 } } };
  assert.equal(activeEventWindow([event], settings, new Date("2026-07-29T17:35:00.000Z"))?.code, "FOMC");
  assert.equal(activeEventWindow([event], settings, new Date("2026-07-29T18:20:00.000Z")), null);
});
