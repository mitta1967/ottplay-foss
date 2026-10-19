const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const ts = require("typescript");
const { cloudSource } = require("./helpers/cloud-source-fixture.cjs");

const source = fs.readFileSync(
    path.join(__dirname, "../src/storage/index.ts"),
    "utf8"
);
const ast = ts.createSourceFile(
    "storage.ts",
    source,
    ts.ScriptTarget.Latest,
    true
);
const names = [
    "stbGetAllItems",
    "portableSettingsSnapshot",
    "restoreLocalSettingsSnapshot",
];
const functions = ast.statements.filter(
    (node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text)
);
assert.equal(functions.length, names.length);
const storageSource = ts
    .transpileModule(functions.map((node) => node.getText(ast)).join("\n"), {
        compilerOptions: {
            module: ts.ModuleKind.ES2015,
            target: ts.ScriptTarget.ES5,
        },
    })
    .outputText.replace(/^export /gm, "");
const valid = JSON.stringify({
    active: -1,
    profiles: Array(15).fill(null),
    version: 1,
});
const privateBindings = JSON.stringify({
    "local-only": { bookmark: "DEVICE-SECRET" },
});

function fixture() {
    const stored = new Map([
        ["ordinary", "before"],
        ["offlineProfileBindings", privateBindings],
    ]);
    const jobs = new Map(),
        requests = [],
        writes = [];
    let next = 0,
        restarts = 0;
    const jquery = () => ({
        hide() {
            return this;
        },
        html() {
            return this;
        },
        show() {
            return this;
        },
    });
    jquery.ajax = (request) => {
        requests.push(request);
        return { abort() {} };
    };
    const w = vm.createContext({
        _: (value) => value,
        __ottOfflineProfiles: {
            validateStore: (value) => JSON.stringify(value) === valid,
        },
        clearTimeout: (id) => jobs.delete(id),
        host_ott: "fixture.invalid",
        host_ott_proto: "https://",
        jQuery: jquery,
        keys: { EXIT: 27, RETURN: 8 },
        p_pref: "offline",
        restart: () => {
            restarts++;
        },
        setTimeout(fn, delay) {
            jobs.set(++next, { delay, fn });
            return next;
        },
        stbDelItem(key) {
            writes.push(key);
            stored.delete(key);
        },
        stbGetItem: (key) => stored.get(key) ?? null,
        stbSetItem(key, value) {
            writes.push(key);
            stored.set(key, value);
        },
        storage: { dump: () => Object.fromEntries(stored) },
    });
    w.window = w;
    require("./helpers/shared-core-runtime.cjs")(w);
    vm.runInContext(cloudSource() + "\n" + storageSource, w);
    function deliver(items) {
        w.cloudLoadSettings();
        requests.at(-1).success({ code: "fixture" });
        [...jobs.values()].find((job) => job.delay === 10000).fn();
        requests
            .at(-1)
            .success({
                data: w.__ottCloudSettingsCodec.write(items),
                status: "success",
            });
    }
    return { deliver, requests, restarts: () => restarts, stored, w, writes };
}

test("all generic exports exclude local bindings and keep portable profiles", () => {
    const { w, stored, requests } = fixture();
    stored.set("offlineProfiles", valid);
    for (const value of [
        w.stbGetAllItems(),
        w.portableSettingsSnapshot(Object.fromEntries(stored)),
    ]) {
        assert.equal(value.offlineProfiles, valid);
        assert.equal(value.offlineProfileBindings, undefined);
        assert(!JSON.stringify(value).includes("DEVICE-SECRET"));
    }
    w.cloudSendSettings();
    assert.equal(requests.length, 1);
    assert(!requests[0].data.d.includes("DEVICE-SECRET"));
    assert.equal(
        w.__ottCloudSettingsCodec.read(requests[0].data.d).offlineProfiles,
        valid
    );
});

for (const rawDump of [false, true]) {
    for (const mode of ["local", "cloud"]) {
        test(
            mode +
                " restore preserves local bindings with " +
                (rawDump ? "legacy" : "filtered") +
                " dump",
            () => {
                const f = fixture();
                if (rawDump)
                    f.w.stbGetAllItems = () => Object.fromEntries(f.stored);
                const imported = {
                    offlineProfileBindings: "FOREIGN-SECRET",
                    offlineProfiles: valid,
                    ordinary: "after",
                };
                if (mode === "local")
                    f.w.restoreLocalSettingsSnapshot(imported);
                else f.deliver(imported);
                assert.equal(f.stored.get("ordinary"), "after");
                assert.equal(f.stored.get("offlineProfiles"), valid);
                assert.equal(
                    f.stored.get("offlineProfileBindings"),
                    privateBindings
                );
                assert(!f.writes.includes("offlineProfileBindings"));
                if (mode === "cloud") assert.equal(f.restarts(), 1);
            }
        );
    }
}

for (const invalid of [
    "{",
    "null",
    JSON.stringify({ bookmark: "FOREIGN-SECRET" }),
    valid,
]) {
    for (const mode of ["local", "cloud"]) {
        test(
            mode +
                " rejects invalid or unverifiable profile store before writes: " +
                invalid.slice(0, 20),
            () => {
                const f = fixture();
                if (invalid === valid) delete f.w.__ottOfflineProfiles;
                const imported = {
                    offlineProfiles: invalid,
                    ordinary: "after",
                };
                if (mode === "local")
                    assert.throws(() =>
                        f.w.restoreLocalSettingsSnapshot(imported)
                    );
                else f.deliver(imported);
                assert.equal(f.writes.length, 0);
                assert.equal(f.restarts(), 0);
                assert.equal(
                    f.stored.get("offlineProfileBindings"),
                    privateBindings
                );
            }
        );
    }
}

test("cloud export rejects malformed portable profiles before uploading", () => {
    const f = fixture();
    f.stored.set(
        "offlineProfiles",
        JSON.stringify({ bookmark: "DEVICE-SECRET" })
    );
    f.w.cloudSendSettings();
    assert.equal(f.requests.length, 0);
    assert.equal(f.writes.length, 0);
});

test("old backups remain compatible and preserve the private binding map", () => {
    const f = fixture();
    delete f.w.__ottOfflineProfiles;
    f.w.restoreLocalSettingsSnapshot({ ordinary: "after" });
    assert.equal(f.stored.get("ordinary"), "after");
    assert.equal(f.stored.get("offlineProfileBindings"), privateBindings);
});
