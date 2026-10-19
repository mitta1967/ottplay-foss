const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const ts = require("typescript");
const { chromium } = require("@playwright/test");
const { stageOfflineShell } = require("../scripts/offline-shell.cjs");
const source = ts.transpileModule(
    fs
        .readFileSync(
            path.join(__dirname, "../src/offline/browser-local-media.ts"),
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
async function main() {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "ott-offline-"));
    let browser, server;
    try {
        fs.mkdirSync(path.join(folder, "dist"));
        fs.mkdirSync(path.join(folder, "logs"));
        fs.mkdirSync(path.join(folder, "js"));
        fs.writeFileSync(path.join(folder, "js/version.js"), "old-version");
        fs.writeFileSync(path.join(folder, "dist/player.js"), source);
        fs.writeFileSync(
            path.join(folder, "index.html"),
            '<!doctype html><script src="/dist/player.js?1.1.55"></script><script>installBrowserLocalMedia(window);installOfflineShell(window);</script>'
        );
        fs.writeFileSync(path.join(folder, "logs/private.js"), "secret");
        fs.writeFileSync(path.join(folder, "private.json"), '{"secret":true}');
        const manifest = stageOfflineShell(folder);
        assert.deepEqual(manifest.assets, [
            "dist/player.js",
            "index.html",
            "js/version.js",
        ]);
        const old = manifest.version;
        fs.appendFileSync(path.join(folder, "dist/player.js"), "\n// update");
        assert.notEqual(stageOfflineShell(folder).version, old);
        const requests = [];
        server = http.createServer((req, res) => {
            const url = new URL(req.url, "http://localhost");
            requests.push(url.pathname + url.search);
            if (url.pathname.startsWith("/api/")) {
                res.end("private");
                return;
            }
            const file = path.join(
                folder,
                url.pathname === "/" ? "index.html" : url.pathname
            );
            if (!fs.existsSync(file)) {
                res.statusCode = 404;
                res.end();
                return;
            }
            res.setHeader(
                "Content-Type",
                file.endsWith(".js") ? "text/javascript" : "text/html"
            );
            res.end(fs.readFileSync(file));
        });
        await new Promise((r) => server.listen(0, "127.0.0.1", r));
        const origin = "http://127.0.0.1:" + server.address().port;
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({ serviceWorkers: "allow" });
        const page = await context.newPage();
        await page.goto(origin);
        await page.evaluate(() => navigator.serviceWorker.ready);
        await page.waitForFunction(() => navigator.serviceWorker.controller);
        assert.equal(
            await page.evaluate(
                async () =>
                    (await window.__ottBrowserLocalMedia.list()).offlineReady
            ),
            true
        );
        const result = await page.evaluate(async () => {
            const api = window.__ottBrowserLocalMedia;
            const first = await api.importFiles([
                new File(["fixture-video"], "clip.mp4", { type: "video/mp4" }),
            ]);
            const repeated = await api.list();
            return {
                data: await (await fetch(first.items[0].url)).text(),
                item: first.items[0],
                repeated: repeated.items[0],
            };
        });
        assert.equal(result.item.name, "clip.mp4");
        assert.equal(
            result.item.url,
            result.repeated.url,
            "listing must preserve a playing object URL"
        );
        assert.equal(result.data, "fixture-video");
        assert.equal(
            await page.evaluate(() =>
                window.__ottBrowserLocalMedia
                    .importFiles([
                        new File(["bad"], "secret.txt", { type: "text/plain" }),
                    ])
                    .then(
                        () => "accepted",
                        (e) => e.message
                    )
            ),
            "Choose supported video or audio files"
        );
        assert.equal(
            await page.evaluate(
                async () =>
                    (await window.__ottBrowserLocalMedia.list()).items.length
            ),
            1
        );
        await page.evaluate(() => fetch("/api/private?token=fixture"));
        const cacheKeys = await page.evaluate(async () => {
            const stores = await caches.keys();
            const keys = await Promise.all(
                stores.map(async (s) =>
                    (await (await caches.open(s)).keys()).map((r) => r.url)
                )
            );
            return keys.flat();
        });
        assert.ok(
            cacheKeys.every(
                (url) =>
                    !url.includes("token") &&
                    !url.includes("/api/") &&
                    !url.includes("private")
            )
        );
        fs.writeFileSync(path.join(folder, "js/version.js"), "new-version");
        assert.equal(
            await page.evaluate(() =>
                fetch("/js/version.js?version=new").then((r) => r.text())
            ),
            "new-version",
            "online app must never be stuck on old assets"
        );
        await context.setOffline(true);
        assert.equal(
            await page.evaluate(() =>
                fetch("/js/version.js?version=old").then((r) => r.text())
            ),
            "old-version",
            "offline fallback preserves the installed version"
        );
        await page.reload();
        const restored = await page.evaluate(async () => {
            const catalog = await window.__ottBrowserLocalMedia.list();
            return {
                data: await (await fetch(catalog.items[0].url)).text(),
                item: catalog.items[0],
            };
        });
        assert.equal(restored.item.id, result.item.id);
        assert.notEqual(
            restored.item.url,
            result.item.url,
            "reload must regenerate nonpersistent blob URL"
        );
        assert.equal(restored.data, "fixture-video");
        assert.equal(
            await page.evaluate(
                async (id) =>
                    (await window.__ottBrowserLocalMedia.remove(id)).items
                        .length,
                result.item.id
            ),
            0
        );
        const missing = await page.evaluate(() =>
            installBrowserLocalMedia({
                addEventListener() {},
                navigator: {},
                URL: {},
            }).list()
        );
        assert.equal(missing.available, false);
        console.log(
            "PASS browser local media: IndexedDB import, stable playback URL, validation, persistence, offline cold reload, no private cache, delete, unsupported browser"
        );
    } finally {
        if (browser) await browser.close();
        if (server) await new Promise((r) => server.close(r));
        fs.rmSync(folder, { force: true, recursive: true });
    }
}
main()
    .then(() => (process.argv.includes("--built-ui") ? builtUi() : null))
    .catch((e) => {
        console.error(e);
        process.exitCode = 1;
    });

async function builtUi() {
    const root = path.resolve(__dirname, "..");
    const dist = path.join(root, "dist");
    if (!fs.existsSync(path.join(dist, "offline-worker.js")))
        throw new Error("Build the player before --built-ui");
    const muxjs = require("mux.js");
    const transmuxer = new muxjs.mp4.Transmuxer({ remux: true });
    let movie;
    transmuxer.on("data", (data) => {
        movie = Buffer.concat([
            Buffer.from(data.initSegment),
            Buffer.from(data.data),
        ]);
    });
    transmuxer.push(
        new Uint8Array(
            fs.readFileSync(
                path.join(root, "tests/fixtures/media-runtime/segment00.ts")
            )
        )
    );
    transmuxer.flush();
    assert.ok(movie && movie.length > 1000);
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, "http://localhost");
        const relative =
            url.pathname === "/" || url.pathname.startsWith("/f/")
                ? "index.html"
                : url.pathname.slice(1);
        const file = path.resolve(dist, relative);
        if (
            !file.startsWith(dist + path.sep) ||
            !fs.existsSync(file) ||
            !fs.statSync(file).isFile()
        ) {
            res.writeHead(404).end();
            return;
        }
        const type = {
            ".css": "text/css",
            ".html": "text/html",
            ".js": "text/javascript",
            ".json": "application/json",
            ".svg": "image/svg+xml",
            ".ttf": "font/ttf",
            ".woff": "font/woff",
            ".woff2": "font/woff2",
        }[path.extname(file)];
        if (type) res.setHeader("Content-Type", type);
        res.end(fs.readFileSync(file));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const browser = await chromium.launch({ headless: true });
    try {
        const context = await browser.newContext({ serviceWorkers: "allow" });
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await page.addInitScript(() => {
            if (!localStorage.getItem("ottplayprov")) {
                localStorage.setItem("ottplaylang", "_eng");
                localStorage.setItem("ottplayprov", "demo");
            }
        });
        const origin = "http://127.0.0.1:" + server.address().port;
        await page.goto(origin + "/f/pc/");
        await page.waitForFunction(
            () =>
                window.__ottLocalMedia &&
                !document.body.classList.contains("booting")
        );
        await page.evaluate(() => {
            window.stbStop();
            window.popLocalMedia();
        });
        const chooserPromise = page.waitForEvent("filechooser");
        await page
            .getByRole("button", { exact: true, name: "Add files" })
            .click();
        await (await chooserPromise).setFiles({
            buffer: movie,
            mimeType: "video/mp4",
            name: "offline-fixture.mp4",
        });
        await page
            .getByText("offline-fixture.mp4 —", { exact: false })
            .waitFor();
        await page
            .getByRole("button", { exact: true, name: "Play local videos" })
            .click();
        await page.waitForFunction(() =>
            Array.from(document.querySelectorAll("video")).some(
                (v) => v.currentTime > 0.1 && !v.error
            )
        );
        const before = await page.evaluate(() => ({
            catalog: window.cList,
            provider: window.stbGetItem("ottplayprov"),
            urls: Object.values(window.chanels || {}).map((c) => c.url),
        }));
        assert.equal(before.provider, "offline");
        await page.evaluate(() => navigator.serviceWorker.ready);
        await page.waitForFunction(() => navigator.serviceWorker.controller);
        await context.setOffline(true);
        await page.reload();
        await page.waitForFunction(
            () =>
                window.__ottLocalMedia &&
                !document.body.classList.contains("booting")
        );
        const autoplay = await page.evaluate(() =>
            document
                .querySelector("video")
                .play()
                .then(
                    () => "played",
                    (error) => error.name
                )
        );
        if (autoplay === "NotAllowedError") {
            await page.keyboard.press("Space");
        }
        await page
            .waitForFunction(
                () =>
                    Array.from(document.querySelectorAll("video")).some(
                        (v) => v.currentTime > 0.1 && !v.error
                    ),
                null,
                { timeout: 5000 }
            )
            .catch(async (error) => {
                console.error(
                    "Offline playback state",
                    await page.evaluate(() => ({
                        catalog: window.cList,
                        channels: window.chanels,
                        provider: window.stbGetItem("ottplayprov"),
                        text: document.body.innerText.slice(0, 1500),
                        videos: Array.from(
                            document.querySelectorAll("video")
                        ).map((v) => ({
                            error: v.error && v.error.code,
                            paused: v.paused,
                            src: v.currentSrc,
                            time: v.currentTime,
                        })),
                    })),
                    errors
                );
                throw error;
            });
        const after = await page.evaluate(() => ({
            catalog: window.cList,
            provider: window.stbGetItem("ottplayprov"),
            urls: Object.values(window.chanels || {}).map((c) => c.url),
        }));
        assert.equal(after.provider, "offline");
        assert.deepEqual(after.catalog, before.catalog);
        assert.notDeepEqual(
            after.urls,
            before.urls,
            "offline driver regenerates blob URLs after cold reload"
        );
        assert.deepEqual(errors, []);
        console.log(
            "PASS built UI: import through file picker, Local videos provider, real MP4 decoding, stable IDs and playback after offline cold reload (with a user gesture when browser autoplay policy requires it)"
        );
    } finally {
        await browser.close();
        await new Promise((r) => server.close(r));
    }
}
