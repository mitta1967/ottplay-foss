const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const load = require("./helpers/remote-notifications.cjs");

function fixture() {
    let clock = 1000000;
    let sequence = 0;
    const jobs = new Map();
    const requests = [];
    const dom = new JSDOM('<div id="notifications"></div>', {
        pretendToBeVisual: true,
    });
    const w = dom.window;
    w.setTimeout = (fn, delay) => {
        jobs.set(++sequence, { at: clock + delay, fn });
        return sequence;
    };
    w.clearTimeout = (id) => jobs.delete(id);
    w.stbIsStandby = () => false;
    const client = load({
        Date: { now: () => clock },
    }).createRemoteNotifications(w, (request, complete) => {
        const call = { aborted: false, complete, request };
        requests.push(call);
        return () => {
            call.aborted = true;
        };
    });
    function configure(
        address = "https://server.invalid/proxy/api/webhook/commands?device_id=tv",
        token = "device-token"
    ) {
        client.configure(address, token);
    }
    function poll() {
        client.poll();
        return requests.at(-1);
    }
    function item(overrides = {}) {
        return {
            duration_ms: 5000,
            expires_at: 1700000015.25,
            id: "a".repeat(32),
            message: "Door opened",
            runtime: new URL(requests.at(-1).request.url).searchParams.get(
                "runtime"
            ),
            severity: "info",
            title: "Home Assistant",
            ...overrides,
        };
    }
    function reply(notifications, overrides = {}, call = requests.at(-1)) {
        call.complete({
            body: JSON.stringify({
                notifications,
                poll_after_ms: 5000,
                server_time: 1700000000.25,
                version: 1,
                ...overrides,
            }),
            status: 200,
        });
    }
    function advance(ms, timers = false) {
        clock += ms;
        if (timers)
            for (const [id, job] of jobs)
                if (job.at <= clock) {
                    jobs.delete(id);
                    job.fn();
                }
    }
    return {
        advance,
        client,
        configure,
        dom,
        item,
        jobs,
        poll,
        reply,
        requests,
        w,
    };
}

{
    const h = fixture();
    h.configure();
    const call = h.poll();
    const url = new URL(call.request.url);
    assert.equal(url.pathname, "/proxy/api/notifications");
    assert.equal(url.searchParams.get("device_id"), "tv");
    assert.equal(url.searchParams.get("active"), "true");
    assert.match(url.searchParams.get("runtime"), /^[A-Za-z0-9_.:-]{1,128}$/);
    assert.equal(call.request.headers.Authorization, "Bearer device-token");
    assert.equal(call.request.timeoutMs, 8000);
    assert.equal(url.toString().includes("device-token"), false);
    const notice = h.item({
        message: '<img src=x onerror="bad()"> & نص',
        title: "<b>Home</b>",
    });
    h.reply([notice, notice]);
    const banner = h.w.document.querySelector(".remote-notify");
    assert.equal(
        banner.textContent,
        '<b>Home</b>\n<img src=x onerror="bad()"> & نص'
    );
    assert.equal(banner.children.length, 0);
    assert.equal(banner.dir, "auto");
    assert.equal(banner.getAttribute("role"), "status");
    assert.equal(h.w.document.querySelectorAll(".remote-notify").length, 1);
    h.advance(4999);
    h.poll();
    assert.equal(h.requests.length, 1, "no early poll");
    h.advance(1);
    h.poll();
    h.reply([notice]);
    assert.equal(
        h.w.document.querySelectorAll(".remote-notify").length,
        1,
        "duplicate delivery is not rendered"
    );
    h.advance(0, true);
    assert.equal(
        h.w.document.querySelectorAll(".remote-notify").length,
        0,
        "display timer removes banner"
    );
    h.dom.window.close();
}

for (const inactive of ["standby", "blocked", "hidden", "native", "booting"]) {
    const h = fixture();
    h.configure();
    h.poll();
    const notice = h.item();
    if (inactive === "standby") h.w.stbIsStandby = () => true;
    if (inactive === "blocked") h.w.__ottStandby = { blocked: () => true };
    if (inactive === "hidden")
        Object.defineProperty(h.w.document, "hidden", {
            configurable: true,
            value: true,
        });
    if (inactive === "native") h.w.__ottScreenAwake = false;
    if (inactive === "booting") h.w.document.body.classList.add("booting");
    h.reply([notice]);
    assert.equal(
        h.w.document.querySelector(".remote-notify"),
        null,
        inactive + " while in flight drops banner"
    );
    h.advance(5000);
    const call = h.poll();
    assert.equal(new URL(call.request.url).searchParams.get("active"), "false");
    h.w.stbIsStandby = () => false;
    h.w.__ottStandby = undefined;
    Object.defineProperty(h.w.document, "hidden", {
        configurable: true,
        value: false,
    });
    h.w.__ottScreenAwake = true;
    h.w.document.body.classList.remove("booting");
    h.reply([h.item({ id: "b".repeat(32) })]);
    assert.equal(
        h.w.document.querySelector(".remote-notify"),
        null,
        "inactive poll never becomes a wake replay"
    );
    h.advance(5000);
    h.poll();
    h.reply([notice]);
    assert.equal(
        h.w.document.querySelector(".remote-notify"),
        null,
        "dropped ID remains deduplicated after wake"
    );
    h.dom.window.close();
}

{
    const h = fixture();
    h.configure();
    h.poll();
    h.reply([h.item()]);
    Object.defineProperty(h.w.document, "hidden", { value: true });
    h.w.document.dispatchEvent(new h.w.Event("visibilitychange"));
    assert.equal(
        h.w.document.querySelector(".remote-notify"),
        null,
        "hiding clears visible banners immediately"
    );
    assert.equal(h.jobs.size, 0);
    h.dom.window.close();
}

{
    const h = fixture();
    h.configure();
    const old = h.poll();
    const stale = h.item();
    h.configure("https://other.invalid/api/webhook/commands", "new-token");
    assert.equal(old.aborted, true);
    h.reply([stale], {}, old);
    assert.equal(h.w.document.querySelector(".remote-notify"), null);
    const current = h.poll();
    assert.notEqual(
        new URL(current.request.url).searchParams.get("runtime"),
        stale.runtime
    );
    h.reply([stale, h.item({ id: "b".repeat(32) })]);
    assert.equal(
        h.w.document.querySelectorAll(".remote-notify").length,
        1,
        "other runtime discarded"
    );
    h.client.stop();
    assert.equal(h.w.document.querySelector(".remote-notify"), null);
    assert.equal(h.jobs.size, 0);
    h.dom.window.close();
}

for (const status of [404, 405, 429, 500]) {
    const h = fixture();
    h.configure();
    h.poll().complete({ body: "", status });
    h.advance(59999);
    h.poll();
    assert.equal(h.requests.length, 1, "optional endpoint failure backs off");
    h.advance(1);
    h.poll();
    assert.equal(h.requests.length, 2);
    h.dom.window.close();
}

for (const overrides of [
    { duration_ms: 999 },
    { duration_ms: 15001 },
    { duration_ms: 1000.5 },
    { title: "x".repeat(129) },
    { message: "x".repeat(513) },
    { message: "" },
    { id: "bad" },
    { severity: "emergency" },
    { expires_at: null },
]) {
    const h = fixture();
    h.configure();
    h.poll();
    h.reply([h.item(overrides)]);
    assert.equal(
        h.w.document.querySelector(".remote-notify"),
        null,
        JSON.stringify(overrides)
    );
    h.dom.window.close();
}

{
    const h = fixture();
    h.configure();
    h.poll();
    h.advance(3000);
    h.reply([h.item({ expires_at: 1700000002.25 })]);
    assert.equal(
        h.w.document.querySelector(".remote-notify"),
        null,
        "full request time subtracted despite skewed device clock"
    );
    h.advance(5000);
    h.poll();
    h.reply(
        [0, 1, 2, 3].map((i) =>
            h.item({
                id: String(i).repeat(32),
                severity: i === 3 ? "critical" : "warning",
            })
        )
    );
    assert.equal(
        h.w.document.querySelectorAll(".remote-notify").length,
        3,
        "bounded DOM banners"
    );
    assert.equal(h.jobs.size, 3, "eviction cancels old timer");
    assert.equal(
        h.w.document.querySelectorAll(".remote-notify-critical").length,
        1
    );
    h.w.stbIsStandby = () => true;
    h.advance(5000);
    h.poll();
    assert.equal(
        h.w.document.querySelectorAll(".remote-notify").length,
        0,
        "inactive heartbeat clears banners"
    );
    assert.equal(h.jobs.size, 0);
    h.dom.window.close();
}

for (const invalid of [
    { notifications: Array(5).fill({}) },
    { version: 2 },
    { server_time: 0 },
    { poll_after_ms: 1 },
    { notifications: {} },
]) {
    const h = fixture();
    h.configure();
    h.poll();
    h.reply([h.item()], invalid);
    assert.equal(h.w.document.querySelector(".remote-notify"), null);
    h.advance(5000);
    h.poll();
    assert.equal(h.requests.length, 1, "invalid envelope does not hot-loop");
    h.dom.window.close();
}

{
    const h = fixture();
    h.configure();
    h.poll();
    h.advance(500);
    h.reply([h.item({ expires_at: 1700000001.25 })]);
    assert.equal(h.w.document.querySelectorAll(".remote-notify").length, 1);
    h.advance(499, true);
    assert.equal(h.w.document.querySelectorAll(".remote-notify").length, 1);
    h.advance(1, true);
    assert.equal(
        h.w.document.querySelector(".remote-notify"),
        null,
        "display duration is clamped to remaining server lifetime"
    );
    h.advance(5000);
    h.poll();
    h.reply([h.item({ id: "b".repeat(32) })]);
    h.w.__ottRemoteNotifications.suspend();
    assert.equal(
        h.w.document.querySelector(".remote-notify"),
        null,
        "standby/native hook clears immediately without another poll"
    );
    h.advance(5000);
    h.poll();
    h.w.__ottRemoteNotifications.suspend();
    h.reply([h.item({ id: "c".repeat(32) })]);
    assert.equal(
        h.w.document.querySelector(".remote-notify"),
        null,
        "sleep then wake invalidates in-flight notifications"
    );
    h.dom.window.close();
}

{
    const h = fixture();
    let monotonic = 100;
    h.w.performance.now = () => monotonic;
    h.configure();
    h.poll();
    monotonic += 3000;
    h.advance(-10000);
    h.reply([h.item({ expires_at: 1700000002.25 })]);
    assert.equal(
        h.w.document.querySelector(".remote-notify"),
        null,
        "wall clock rollback cannot revive an expired in-flight event"
    );
    h.dom.window.close();
}

{
    const h = fixture();
    h.configure();
    h.poll();
    const beforeSleep = h.item();
    h.reply([]);
    h.client.suspend();
    h.advance(5000);
    const resumed = h.poll();
    const resumedRuntime = new URL(resumed.request.url).searchParams.get(
        "runtime"
    );
    assert.notEqual(
        resumedRuntime,
        beforeSleep.runtime,
        "fast sleep/wake retires server queue even without an inactive heartbeat"
    );
    h.reply([beforeSleep]);
    assert.equal(h.w.document.querySelector(".remote-notify"), null);
    h.configure();
    const reconnected = h.poll();
    assert.notEqual(
        new URL(reconnected.request.url).searchParams.get("runtime"),
        resumedRuntime,
        "same-credential reenable cannot replay the disconnected session's queue"
    );
    h.dom.window.close();
}

console.log(
    "Remote notifications: literal bounded banners, activity, expiry, runtime isolation and optional endpoint backoff passed"
);
