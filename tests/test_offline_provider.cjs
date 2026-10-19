const assert = require("node:assert/strict");
const test = require("node:test");
const { fixture } = require("./helpers/provider-driver-fixture.cjs");

test("offline provider resolves stable IDs to fresh URLs after reload, without network", async () => {
    const f = fixture();
    let url = "blob:first-session";
    f.host.__ottLocalMedia = {
        list: async () => ({
            items: [{ id: "abc", name: "Tom and Jerry.mp4", url }],
        }),
    };
    const first = f.mount("offline");
    const load = (driver) => new Promise((resolve) => driver.load(resolve));
    let catalog = await load(first);
    assert.deepEqual(Array.from(catalog.ids), ["local-abc"]);
    assert.equal(first.stream("local-abc"), url);
    assert.equal(
        catalog.channels["local-abc"].channel_name,
        "Tom and Jerry.mp4"
    );
    url = "blob:second-session";
    const second = f.mount("offline");
    catalog = await load(second);
    assert.deepEqual(Array.from(catalog.ids), ["local-abc"]);
    assert.equal(second.stream("local-abc"), url);
    assert.equal(first.stream("local-abc"), "");
    assert.equal(f.requests.length, 0);
});

test("offline catalog completion cannot publish after a provider switch", async () => {
    const f = fixture();
    let deliver;
    f.host.__ottLocalMedia = {
        list: () =>
            new Promise((resolve) => {
                deliver = resolve;
            }),
    };
    const driver = f.mount("offline");
    let published = false;
    driver.load(() => {
        published = true;
    });
    f.mount("demo");
    deliver({ items: [{ id: "late", name: "Late.mp4", url: "blob:late" }] });
    await Promise.resolve();
    assert.equal(published, false);
    assert.equal(driver.stream("local-late"), "");
});

test("offline storage failure settles the catalog with an actionable error", async () => {
    const f = fixture();
    f.host.__ottLocalMedia = {
        list: async () => {
            throw new Error("Storage unavailable");
        },
    };
    const driver = f.mount("offline");
    const result = await new Promise((resolve) =>
        driver.load((catalog, error) => resolve({ catalog, error }))
    );
    assert.equal(result.error, "Storage unavailable");
    assert.equal(result.catalog.ids.length, 0);
});

test("empty offline provider opens import after settling the catalog", async () => {
    const f = fixture();
    const events = [];
    f.host.__ottLocalMedia = {
        list: async () => ({ items: [] }),
        open: () => events.push("import"),
    };
    f.mount("offline").load(() => events.push("settled"));
    await Promise.resolve();
    assert.deepEqual(events, ["settled", "import"]);
});

test("empty catalog callback cannot reopen import after provider replacement", async () => {
    const f = fixture();
    let opened = false;
    f.host.__ottLocalMedia = {
        list: async () => ({ items: [] }),
        open: () => {
            opened = true;
        },
    };
    f.mount("offline").load(() => f.mount("demo"));
    await Promise.resolve();
    assert.equal(opened, false);
});
