const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const code = ts.transpileModule(
    fs.readFileSync("src/storage/index.ts", "utf8"),
    {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES5,
        },
    }
).outputText;
require("acorn").parse(code, { ecmaVersion: 5 });
function backing(initial) {
    const map = new Map(Object.entries(initial));
    const snapshots = [];
    const port = {
        clear() {
            map.clear();
        },
        getItem: (key) => map.get(key) ?? null,
        key: (index) => [...map.keys()][index],
        get length() {
            return map.size;
        },
        map,
        removeItem(key) {
            map.delete(key);
            snapshots.push(Object.fromEntries(map));
        },
        setItem(key, value) {
            if (port.reject === key) throw Error("quota");
            map.set(key, value);
            snapshots.push(Object.fromEntries(map));
        },
        snapshots,
    };
    return port;
}
function load(port) {
    const context = {
        document: { cookie: "" },
        exports: {},
        window: { localStorage: port },
    };
    vm.runInNewContext(code, context);
    return context.exports;
}
const initial = { one: "old", removed: "before", untouched: "same" };
const expected = { added: "after", one: "new", untouched: "same" };
const writes = [
    { after: "new", before: "old", key: "one" },
    { after: null, before: "before", key: "removed" },
    { after: "after", before: null, key: "added" },
];
const port = backing(initial),
    api = load(port);
api.writeSettingsJournal(port, writes, () => true);
assert.deepEqual(Object.fromEntries(port.map), expected);
for (const snapshot of port.snapshots) {
    const restored = backing(snapshot);
    load(restored); // Actual bootstrap recovery, before any caller reads settings.
    assert.deepEqual(
        Object.fromEntries(restored.map),
        snapshot.ottplaySettingsJournalV1 ? initial : expected
    );
}
const prepared = port.snapshots[1];
const repeated = backing(prepared);
api.recoverSettingsJournal(repeated);
for (const snapshot of repeated.snapshots) {
    const restarted = backing(snapshot);
    load(restarted);
    assert.deepEqual(
        Object.fromEntries(restarted.map),
        initial,
        "Recovery itself can restart after every write"
    );
}
const foreign = backing({ ...prepared, one: "external" });
api.recoverSettingsJournal(foreign);
assert.equal(foreign.getItem("one"), "external");
const full = backing(initial);
full.reject = "ottplaySettingsJournalV1";
assert.throws(
    () => api.writeSettingsJournal(full, writes, () => true),
    /quota/
);
assert.deepEqual(Object.fromEntries(full.map), initial);
const invalid = backing({
    ...initial,
    ottplaySettingsJournalV1:
        '{"version":1,"writes":[{"key":"one","after":"old"}]}',
});
assert.throws(() => load(invalid), /Invalid settings journal/);
assert.equal(invalid.getItem("one"), "old");
assert.equal(api.isStorageMetadataKey("ottplaySettingsJournalV1"), true);
const originalJournal = JSON.stringify({
    version: 1,
    writes: [{ after: "new", before: "old", key: "one" }],
});
const foreignJournal = JSON.stringify({
    version: 1,
    writes: [{ after: "foreign", before: null, key: "two" }],
});
const replaced = backing({
    one: "new",
    ottp: "unrelated",
    ottplaySettingsJournalV1: originalJournal,
});
const originalSet = replaced.setItem;
replaced.setItem = function (key, value) {
    originalSet(key, value);
    if (key === "one")
        replaced.map.set("ottplaySettingsJournalV1", foreignJournal);
};
assert.throws(
    () => api.recoverSettingsJournal(replaced),
    /Settings journal changed/
);
assert.equal(
    replaced.getItem("ottplaySettingsJournalV1"),
    foreignJournal,
    "Recovery must not remove a replacement journal"
);
console.log(
    "PASS settings journal: bootstrap/crash at every write, repeated recovery, foreign edits, quota, invalid data, metadata exclusion"
);
