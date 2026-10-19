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

test("unavailable source entries never become playable channels", async () => {
    const f = fixture();
    f.host.__ottLocalMedia = {
        list: async () => ({
            items: [
                {
                    available: false,
                    id: "missing",
                    name: "Missing.mp4",
                    url: "",
                },
                {
                    available: false,
                    id: "denied",
                    name: "Denied.mp4",
                    url: "blob:stale",
                },
                {
                    available: true,
                    id: "ready",
                    name: "Ready.mp4",
                    url: "blob:ready",
                },
            ],
        }),
    };
    const driver = f.mount("offline");
    const catalog = await new Promise((resolve) => driver.load(resolve));
    assert.deepEqual(Array.from(catalog.ids), ["local-ready"]);
    assert.equal(driver.stream("local-denied"), "");
});

// Exercise the real startup callback: a temporarily inaccessible local folder
// must not replace the last selected file with a nonexistent first channel.
function startupFixture(provider) {
    const fs = require("node:fs");
    const vm = require("node:vm");
    const ts = require("typescript");
    const filename = require("node:path").join(
        __dirname,
        "../src/channels/index.ts"
    );
    const ast = ts.createSourceFile(
        filename,
        fs.readFileSync(filename, "utf8"),
        ts.ScriptTarget.Latest,
        true
    );
    const fn = ast.statements.find(
        (node) =>
            ts.isFunctionDeclaration(node) &&
            node.name?.text === "onChannelsLoaded"
    );
    const source = ts.transpileModule(fn.getText(ast).replace(/^export /, ""), {
        compilerOptions: {
            module: ts.ModuleKind.None,
            target: ts.ScriptTarget.ES5,
        },
    }).outputText;
    const saved = {
        catIndex: 0,
        channelId: "local-source:fourth.mp4",
        primaryIndex: 3,
    };
    const plays = [];
    let writes = 0;
    const host = {
        __ottActiveProviderDriver: { capabilities: {}, id: provider },
        __ottChannels: { mount() {} },
        __ottClassicPlayback: {
            hydrate() {
                host.primaryIndex = saved.primaryIndex;
                host.catIndex = saved.catIndex;
            },
        },
        $: () => ({ hide() {} }),
        catIndex: saved.catIndex,
        cList: [],
        clearBootHide() {},
        console: {
            error(error) {
                throw error;
            },
            log() {},
        },
        document: { getElementById: () => null },
        loadEpgTimers() {},
        loadFavoritesLists() {},
        playChannel(category, index) {
            plays.push([category, index]);
        },
        popupActions: [() => {}],
        popupList() {},
        primaryIndex: saved.primaryIndex,
        restoreContinueWatch: () => false,
        setCurrent(category, index) {
            writes++;
            saved.catIndex = category;
            saved.primaryIndex = index;
            delete saved.channelId;
        },
        sFavorites: false,
    };
    host.window = host;
    vm.createContext(host);
    vm.runInContext(source, host);
    return { host, plays, saved, writes: () => writes };
}

test("permission-blocked local startup preserves selection and resumes it after recovery", () => {
    const f = startupFixture("offline");
    f.host.onChannelsLoaded();
    assert.equal(f.writes(), 0);
    assert.equal(f.saved.channelId, "local-source:fourth.mp4");
    assert.equal(f.saved.primaryIndex, 3);
    assert.deepEqual(f.plays, []);
    f.host.cList = ["first", "second", "third", f.saved.channelId];
    f.host.onChannelsLoaded();
    assert.deepEqual(f.plays, [[0, 3]]);
    assert.equal(f.writes(), 0);
});

test("empty non-local provider retains its existing selection-reset behavior", () => {
    const f = startupFixture("m3u");
    f.host.onChannelsLoaded();
    assert.equal(f.writes(), 1);
    assert.equal(f.saved.primaryIndex, 0);
});

test("permission-blocked source opens playback recovery instead of settings", async () => {
    const f = fixture();
    const events = [];
    f.host.__ottLocalMedia = {
        list: async () => ({
            items: [],
            sources: [{ access: "permission-required", id: "source" }],
        }),
        open: () => events.push("settings"),
        resume: () => events.push("resume"),
    };
    f.mount("offline").load(() => events.push("settled"));
    await Promise.resolve();
    assert.deepEqual(events, ["settled", "resume"]);
});
