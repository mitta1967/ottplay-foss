const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const ts = require("typescript");
const { chromium } = require("@playwright/test");
const source = ts.transpileModule(
    fs
        .readFileSync(
            require("node:path").join(
                __dirname,
                "../src/offline/browser-local-media.ts"
            ),
            "utf8"
        )
        .replace(/^export /gm, ""),
    {
        compilerOptions: {
            module: ts.ModuleKind.None,
            target: ts.ScriptTarget.ES5,
        },
    }
).outputText;
require("acorn").parse(source, { ecmaVersion: 5 });
(async () => {
    const server = http.createServer((req, res) =>
        res.end("<script>" + source + "</script>")
    );
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.goto("http://127.0.0.1:" + server.address().port);
        const result = await page.evaluate(async () => {
            const root = await navigator.storage.getDirectory();
            const dir = await root.getDirectoryHandle("fixture", {
                create: true,
            });
            const nested = await dir.getDirectoryHandle("nested", {
                create: true,
            });
            async function put(folder, name, data) {
                const f = await folder.getFileHandle(name, { create: true });
                const out = await f.createWritable();
                await out.write(data);
                await out.close();
                return f;
            }
            await put(nested, "movie.mp4", "original");
            await put(dir, "notes.txt", "skip");
            window.showDirectoryPicker = () => Promise.resolve(dir);
            const api = installBrowserLocalMedia(window);
            const initial = await api.importFolder();
            const db = await new Promise((resolve, reject) => {
                const r = indexedDB.open("ott-local-media", 1);
                r.onsuccess = () => resolve(r.result);
                r.onerror = () => reject(r.error);
            });
            const stored = await new Promise((resolve) => {
                const r = db.transaction("files").objectStore("files").getAll();
                r.onsuccess = () => resolve(r.result);
            });
            await put(nested, "movie.mp4", "replacement-is-longer");
            const updated = await api.list();
            const body = await (await fetch(updated.items[0].url)).text();
            await put(nested, "second.mp4", "second");
            const refreshed = await api.list();
            const originalQuery =
                FileSystemDirectoryHandle.prototype.queryPermission;
            FileSystemDirectoryHandle.prototype.queryPermission = () =>
                Promise.resolve("prompt");
            const locked = await api.list();
            FileSystemDirectoryHandle.prototype.queryPermission = originalQuery;
            const reconnected = await api.requestAccess();
            await api.removeSource(initial.sources[0].id);
            const preserved = await (
                await nested.getFileHandle("movie.mp4")
            ).getFile();
            await new Promise((resolve) => {
                const tx = db.transaction("files", "readwrite");
                tx.objectStore("files").put({
                    blob: new Blob(["legacy"], { type: "video/mp4" }),
                    created: 1,
                    id: "legacy",
                    name: "legacy.mp4",
                });
                tx.oncomplete = resolve;
            });
            const legacy = await api.list();
            window.showDirectoryPicker = undefined;
            let unsupported = "";
            try {
                await api.importFolder();
            } catch (e) {
                unsupported = e.message;
            }
            return {
                body,
                initial,
                legacy,
                locked,
                preserved: preserved.size,
                reconnected,
                refreshed,
                stored: stored.map((r) => ({
                    hasBlob: !!r.blob,
                    hasHandle: !!r.handle,
                })),
                unsupported,
            };
        });
        assert.equal(result.initial.items.length, 1);
        assert.equal(result.initial.items[0].name, "nested/movie.mp4");
        assert.deepEqual(result.stored, [{ hasBlob: false, hasHandle: true }]);
        assert.equal(result.body, "replacement-is-longer");
        assert.equal(result.refreshed.items.length, 2);
        assert.equal(result.locked.items[0].access, "permission-required");
        assert.equal(result.locked.items[0].url, "");
        assert.equal(result.reconnected.items.length, 2);
        assert.ok(result.preserved > 0);
        assert.equal(result.legacy.items[0].source, "imported");
        assert.match(result.unsupported, /Direct folder access is unavailable/);
        await page.reload();
        const legacy = await page.evaluate(async () => {
            const list = await installBrowserLocalMedia(window).list();
            return (await fetch(list.items[0].url)).text();
        });
        assert.equal(legacy, "legacy");
        await page.evaluate(async () => {
            const root = await navigator.storage.getDirectory();
            const dir = await root.getDirectoryHandle("fixture");
            window.showDirectoryPicker = () => Promise.resolve(dir);
            await window.__ottBrowserLocalMedia.importFolder();
        });
        await page.reload();
        const restored = await page.evaluate(async () => {
            const list = await installBrowserLocalMedia(window).list();
            return {
                linked: list.items.filter((i) => i.source === "linked").length,
                sources: list.sources.length,
            };
        });
        assert.equal(restored.linked, 2);
        assert.equal(restored.sources, 1);
        console.log(
            "PASS direct browser sources: recursive read, handle-only storage, fresh file reads, refresh, permission status/reconnect, disconnect preserves originals, legacy blobs, unsupported browser"
        );
    } finally {
        await browser.close();
        await new Promise((r) => server.close(r));
    }
})().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
