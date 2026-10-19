const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const vm = require("node:vm");
const source = ts.transpileModule(
    fs.readFileSync(
        path.join(__dirname, "../src/plugins/local-media.ts"),
        "utf8"
    ),
    {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES5,
        },
    }
).outputText;
require("acorn").parse(source, { ecmaVersion: 5 });
const helperModule = { exports: {} };
vm.runInNewContext(
    ts.transpileModule(
        fs.readFileSync(
            path.join(__dirname, "../src/offline/local-media-progress.ts"),
            "utf8"
        ),
        {
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES5,
            },
        }
    ).outputText,
    { exports: helperModule.exports }
);

function catalog(scanned, count, scanning = true) {
    return {
        items: Array.from({ length: count }, (_, index) => ({
            id: String(index),
            url: "/video/" + index,
        })),
        scanned,
        scanning,
        sources: [{ available: true, id: "folder" }],
        total: scanning ? null : scanned,
    };
}
function fixture(snapshots, options = {}) {
    let reads = 0,
        scheduled = [],
        now = 0;
    const commands = [];
    let aborts = 0;
    let dialogOwner = null,
        dialogHtml = "",
        played = 0;
    const progressNode = { textContent: "" };
    const listOwner = {
        active: () => true,
        foreground: () => !dialogOwner,
    };
    function openDialog() {
        const owner = {
            close() {
                if (dialogOwner === owner) dialogOwner = null;
            },
            foreground: () => dialogOwner === owner,
        };
        dialogOwner = owner;
        return owner;
    }
    const w = {
        _: (text) => text,
        __ottClassicScreenPort: {
            listOwner: () => listOwner,
            setOwnedCallback: () => ({ owner: openDialog() }),
        },
        __TAURI__: {},
        $() {
            return {
                hide() {
                    return this;
                },
                html(value) {
                    dialogHtml = value;
                    return this;
                },
                show() {
                    return this;
                },
            };
        },
        closeList() {},
        document: { getElementById: () => progressNode },
        fetch: async () => ({
            json: async () =>
                snapshots[Math.min(reads++, snapshots.length - 1)],
            ok: true,
        }),
        keys: { ENTER: 13, EXIT: 8, RETURN: 27 },
        listCaption: {},
        listDetail: {},
        listFooter: {},
        loadProv() {
            played++;
            openDialog();
            dialogHtml = "provider-spinner";
        },
        optionsList() {},
        renderButtonHint: () => "",
        showPage() {},
        stbSetItem() {},
    };
    if (options.fetch) w.fetch = options.fetch;
    if (options.abortable !== false)
        w.AbortController = class {
            signal = {};
            abort() {
                aborts++;
            }
        };
    const module = { exports: {} };
    vm.runInNewContext(source, {
        clearTimeout(task) {
            scheduled = scheduled.filter((item) => item !== task);
        },
        Date: { now: () => now },
        exports: module.exports,
        require(name) {
            if (name.includes("browser-local-media"))
                return {
                    installBrowserLocalMedia: () => ({}),
                    installOfflineShell() {},
                };
            if (name.includes("offline/profiles"))
                return { installOfflineProfiles() {} };
            if (name.includes("local-media-progress"))
                return helperModule.exports;
            return {
                resolveNativePlugin: () => ({}),
                tauriInvoke: async (name, args) => {
                    commands.push({ args, name });
                    return name === "offline_media_endpoint"
                        ? { endpoint: "http://localhost/catalog" }
                        : options.pickerCancelled
                          ? { pickerCancelled: true }
                          : {};
                },
            };
        },
        setTimeout(fn, delay) {
            const task = { delay, fn };
            scheduled.push(task);
            return task;
        },
        URL,
    });
    const api = module.exports.installLocalMedia(w);
    return {
        aborts: () => aborts,
        api,
        commands,
        html: () => dialogHtml,
        played: () => played,
        progress: () => progressNode.textContent,
        queued: () => scheduled.length,
        reads: () => reads,
        async tick(elapsed = 250) {
            now += elapsed;
            const callback = scheduled.shift();
            assert.ok(callback, "a further catalog request is scheduled");
            callback.fn();
            await flush();
        },
        w,
    };
}
async function flush() {
    for (let index = 0; index < 12; index++) await Promise.resolve();
}
(async () => {
    const f = fixture([
        catalog(0, 0),
        catalog(1, 1),
        catalog(1, 1),
        catalog(2, 2, false),
    ]);
    const seen = [];
    let complete = false;
    const result = f.api
        .list((value) => seen.push(value.items.length))
        .then((value) => {
            complete = true;
            return value;
        });
    await flush();
    assert.deepEqual(seen, [0]);
    await f.tick();
    assert.deepEqual(
        seen,
        [0, 1],
        "first native item reaches playback before the full scan"
    );
    assert.equal(complete, false);
    const readsBeforeSnapshot = f.reads();
    await assert.rejects(f.api.snapshot(), /scan to finish/);
    assert.equal(
        f.reads(),
        readsBeforeSnapshot,
        "profile snapshot never starts another native scan"
    );
    await f.tick();
    assert.deepEqual(
        seen,
        [0, 1],
        "unchanged polling is not a progress heartbeat"
    );
    await f.tick();
    assert.equal((await result).items.length, 2);
    assert.deepEqual(seen, [0, 1, 2]);
    const completed = await f.api.snapshot();
    assert.equal(completed.items.length, 2);
    completed.items.length = 0;
    assert.equal(
        (await f.api.snapshot()).items.length,
        2,
        "snapshots are isolated from callers"
    );

    const imported = fixture([
        catalog(0, 0),
        catalog(1, 1),
        catalog(10000, 10000, false),
    ]);
    let importedDone = false;
    const importResult = imported.api.importFiles(true).then((value) => {
        importedDone = true;
        return value;
    });
    await flush();
    assert.equal(importedDone, false);
    await imported.tick();
    assert.equal(
        (await importResult).items.length,
        1,
        "first folder import does not wait for all 10,000 files"
    );
    assert.equal(imported.queued(), 0);
    assert.equal(imported.reads(), 2);

    const ui = fixture([
        catalog(1, 0),
        catalog(2, 1),
        catalog(10000, 10000, false),
    ]);
    ui.api.open(false, true);
    ui.w.listArray.find((row) => row.id === "add-folder").action();
    await flush();
    assert.match(
        ui.html(),
        /ott-spinner/,
        "first add uses the standard owned spinner"
    );
    assert.equal(
        ui.progress(),
        "Loading. Please wait... (1) · Local videos: 0",
        "ongoing import shows actual progress without an invented total"
    );
    assert.equal(ui.played(), 0);
    await ui.tick();
    assert.equal(
        ui.played(),
        1,
        "first playable batch automatically opens the player"
    );
    assert.equal(
        ui.html(),
        "provider-spinner",
        "old manager completion does not close the provider spinner"
    );
    assert.equal(ui.queued(), 0);

    const knownSnapshot = catalog(7, 0);
    knownSnapshot.total = 10000;
    knownSnapshot.items.push({
        available: false,
        id: "unavailable",
        url: "/offline",
    });
    const known = fixture([knownSnapshot]);
    known.api.open(false, true);
    known.w.listArray.find((row) => row.id === "add-folder").action();
    await flush();
    assert.equal(
        known.progress(),
        "Loading. Please wait... (7 / 10000) · Local videos: 0"
    );
    assert.equal(
        known.played(),
        0,
        "unavailable items do not activate playback"
    );
    known.w.listKeyHandler(known.w.keys.RETURN);
    await known.tick();

    const closed = fixture([catalog(1, 0), catalog(2, 1)]);
    closed.api.open(false, true);
    closed.w.listArray.find((row) => row.id === "add-folder").action();
    await flush();
    closed.w.listKeyHandler(closed.w.keys.RETURN);
    await closed.tick();
    assert.equal(
        closed.played(),
        0,
        "closing the manager prevents a late import from opening playback"
    );
    assert.equal(closed.reads(), 1, "closing the manager stops its poller");

    const refreshed = fixture([catalog(2, 1, false)]);
    await refreshed.api.list();
    assert.equal(
        refreshed.commands.filter((command) => command.args.refresh).length,
        0,
        "ordinary catalog reads never restart scanning"
    );
    refreshed.api.open(false, true);
    refreshed.w.listArray.find((row) => row.id === "refresh").action();
    await flush();
    assert.equal(
        refreshed.commands.filter((command) => command.args.refresh).length,
        1,
        "explicit Refresh starts a native rescan once"
    );

    const cancelled = fixture([catalog(0, 0), catalog(1, 1, false)]);
    const first = cancelled.api.list(() => true);
    await flush();
    const replacement = cancelled.api.list();
    await flush();
    assert.equal((await replacement).items.length, 1);
    await cancelled.tick();
    assert.equal((await first).cancelled, true);
    assert.equal(
        cancelled.reads(),
        2,
        "superseded polling cannot start another read"
    );

    for (const abortable of [true, false]) {
        const hanging = fixture([], {
            abortable,
            fetch: () => new Promise(() => {}),
        });
        const deadline = hanging.api.list().then(
            () => null,
            (error) => error
        );
        await flush();
        assert.equal(
            hanging.queued(),
            1,
            "a request that never resolves has a deadline"
        );
        await hanging.tick(60000);
        assert.match((await deadline).message, /stopped responding/);
        assert.equal(hanging.aborts(), abortable ? 1 : 0);
        assert.equal(hanging.queued(), 0);
    }
    const rejected = fixture([], {
        fetch: () => {
            throw new Error("Fetch failed");
        },
    });
    const rejectedResult = await rejected.api.list().then(
        () => null,
        (error) => error
    );
    assert.match(rejectedResult.message, /Fetch failed/);
    assert.equal(
        rejected.queued(),
        0,
        "synchronous fetch failure also cleans up the timer"
    );

    const hangingBody = fixture([], {
        fetch: async () => ({ json: () => new Promise(() => {}), ok: true }),
    });
    const bodyDeadline = hangingBody.api.list().then(
        () => null,
        (error) => error
    );
    await flush();
    await hangingBody.tick(60000);
    assert.match((await bodyDeadline).message, /stopped responding/);
    assert.equal(
        hangingBody.aborts(),
        1,
        "body timeout aborts the request too"
    );

    const pickerCancel = fixture([catalog(1, 1, false)], {
        pickerCancelled: true,
    });
    await pickerCancel.api.list();
    pickerCancel.api.open(false, true);
    pickerCancel.w.listArray.find((row) => row.id === "add-folder").action();
    await flush();
    assert.equal(
        pickerCancel.reads(),
        1,
        "cancelled picker does not restart catalog polling"
    );
    assert.equal(
        pickerCancel.played(),
        0,
        "cancelled picker cannot autoplay an existing item"
    );
    assert.equal(pickerCancel.queued(), 0);
    assert.equal(
        (await pickerCancel.api.importFiles(true)).pickerCancelled,
        true
    );

    const stopped = fixture([catalog(0, 0)]);
    const stopResult = stopped.api.list(() => false);
    assert.equal((await stopResult).cancelled, true);
    assert.equal(stopped.queued(), 0);

    const stalled = fixture([catalog(0, 0)]);
    const stalledResult = stalled.api.list().then(
        () => null,
        (error) => error
    );
    await flush();
    await stalled.tick(60000);
    assert.match((await stalledResult).message, /stopped responding/);
    assert.equal(stalled.queued(), 0);
    console.log(
        "OK: Tauri catalog polling starts early, reports real progress, cancels stale reads, and bounds stalled scans"
    );
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
