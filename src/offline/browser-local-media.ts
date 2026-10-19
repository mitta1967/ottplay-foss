/** Device-local browser library. Blobs never leave this origin. */
export function installBrowserLocalMedia(w: any): any {
    if (w.__ottBrowserLocalMedia) return w.__ottBrowserLocalMedia;
    var dbPromise: Promise<any> | null = null;
    var urls: { [id: string]: string } = {};
    var urlApi = w.URL || w.webkitURL;
    var available = !!(w.indexedDB && urlApi && urlApi.createObjectURL);

    function open(): Promise<any> {
        if (!available)
            return Promise.reject(
                new Error("Local media storage is unavailable in this browser")
            );
        if (!dbPromise)
            dbPromise = new Promise(function (resolve, reject) {
                var request = w.indexedDB.open("ott-local-media", 1);
                request.onupgradeneeded = function () {
                    request.result.createObjectStore("files", {
                        keyPath: "id",
                    });
                };
                request.onsuccess = function () {
                    var db = request.result;
                    db.onversionchange = function () {
                        db.close();
                        dbPromise = null;
                    };
                    resolve(db);
                };
                request.onerror = function () {
                    dbPromise = null;
                    reject(new Error("Could not open local media storage"));
                };
                request.onblocked = function () {
                    dbPromise = null;
                    reject(
                        new Error(
                            "Close other player tabs to update local media storage"
                        )
                    );
                };
            });
        return dbPromise;
    }
    function persisted(): Promise<boolean> {
        try {
            return w.navigator.storage && w.navigator.storage.persisted
                ? Promise.resolve(w.navigator.storage.persisted()).catch(
                      function () {
                          return false;
                      }
                  )
                : Promise.resolve(false);
        } catch (_) {
            return Promise.resolve(false);
        }
    }
    function requestPersistence(): void {
        try {
            if (w.navigator.storage && w.navigator.storage.persist)
                Promise.resolve(w.navigator.storage.persist()).catch(
                    function () {}
                );
        } catch (_) {}
    }
    function list(): Promise<any> {
        if (!available)
            return Promise.resolve({
                available: false,
                items: [],
                offlineReady: false,
                persistent: false,
                storage: "browser",
            });
        return open()
            .then(function (db) {
                return new Promise<any[]>(function (resolve, reject) {
                    var records: any[] = [];
                    var transaction = db.transaction("files", "readonly");
                    var request = transaction.objectStore("files").openCursor();
                    request.onsuccess = function () {
                        var cursor = request.result;
                        if (cursor) {
                            records.push(cursor.value);
                            cursor.continue();
                        }
                    };
                    transaction.oncomplete = function () {
                        resolve(records);
                    };
                    transaction.onerror = transaction.onabort = function () {
                        reject(new Error("Could not read local media storage"));
                    };
                });
            })
            .then(function (records) {
                var live: { [id: string]: boolean } = {};
                var items = records
                    .sort(function (a, b) {
                        return (
                            a.created - b.created || a.id.localeCompare(b.id)
                        );
                    })
                    .map(function (record) {
                        live[record.id] = true;
                        if (!urls[record.id])
                            urls[record.id] = urlApi.createObjectURL(
                                record.blob
                            );
                        return {
                            id: record.id,
                            mime: record.mime,
                            name: record.name,
                            size: record.size,
                            url: urls[record.id],
                        };
                    });
                Object.keys(urls).forEach(function (id) {
                    if (!live[id]) {
                        urlApi.revokeObjectURL(urls[id]);
                        delete urls[id];
                    }
                });
                return persisted().then(function (value) {
                    return {
                        available: true,
                        items: items,
                        offlineReady: !!(
                            w.navigator.serviceWorker &&
                            w.navigator.serviceWorker.controller &&
                            /\/offline-worker\.js(?:[?#]|$)/.test(
                                w.navigator.serviceWorker.controller.scriptURL
                            )
                        ),
                        persistent: value,
                        storage: "browser",
                    };
                });
            });
    }
    function choose(): Promise<any[]> {
        return new Promise(function (resolve) {
            var input = w.document.createElement("input");
            input.type = "file";
            input.accept =
                "video/*,audio/*,.mp4,.m4v,.webm,.mp3,.m4a,.ogg,.wav,.mov";
            input.multiple = true;
            input.style.display = "none";
            var done = false;
            function finish(files: any[]): void {
                if (done) return;
                done = true;
                w.removeEventListener("focus", focus);
                if (input.parentNode) input.parentNode.removeChild(input);
                resolve(files);
            }
            function focus(): void {
                w.setTimeout(function () {
                    if (!done && !input.files.length) finish([]);
                }, 1000);
            }
            input.onchange = function () {
                finish(Array.prototype.slice.call(input.files || []));
            };
            input.oncancel = function () {
                finish([]);
            };
            w.addEventListener("focus", focus);
            w.document.body.appendChild(input);
            input.click();
        });
    }
    function importFiles(files?: ArrayLike<File>): Promise<any> {
        if (!available) return open();
        requestPersistence();
        var selection = files
            ? Promise.resolve(Array.prototype.slice.call(files))
            : choose();
        return selection
            .then(function (selected) {
                // Validate before starting the transaction; rejected imports leave no partial library.
                selected.forEach(function (file) {
                    if (
                        !file ||
                        typeof file.size !== "number" ||
                        typeof file.slice !== "function" ||
                        !(
                            /^(video|audio)\//i.test(file.type || "") ||
                            /\.(mp4|m4v|webm|mp3|m4a|ogg|wav|mov)$/i.test(
                                file.name || ""
                            )
                        )
                    )
                        throw new Error(
                            "Choose supported video or audio files"
                        );
                });
                if (!selected.length) return null;
                return open().then(function (db) {
                    return new Promise(function (resolve, reject) {
                        var tx = db.transaction("files", "readwrite");
                        var store = tx.objectStore("files");
                        selected.forEach(function (file, index) {
                            var id =
                                "local-" +
                                Date.now().toString(36) +
                                "-" +
                                index +
                                "-" +
                                Math.random().toString(36).slice(2);
                            store.add({
                                blob: file,
                                created: Date.now(),
                                id: id,
                                mime: file.type || "application/octet-stream",
                                name: file.name || "Local media",
                                size: file.size,
                            });
                        });
                        tx.oncomplete = function () {
                            resolve(null);
                        };
                        tx.onerror = tx.onabort = function () {
                            reject(
                                new Error(
                                    tx.error &&
                                        tx.error.name === "QuotaExceededError"
                                        ? "Not enough browser storage for these files"
                                        : "Could not save local media files"
                                )
                            );
                        };
                    });
                });
            })
            .then(list);
    }
    function remove(id: string): Promise<any> {
        return open()
            .then(function (db) {
                return new Promise(function (resolve, reject) {
                    var tx = db.transaction("files", "readwrite");
                    tx.objectStore("files").delete(id);
                    tx.oncomplete = function () {
                        resolve(null);
                    };
                    tx.onerror = tx.onabort = function () {
                        reject(new Error("Could not remove local media file"));
                    };
                });
            })
            .then(list);
    }
    var api = { importFiles: importFiles, list: list, remove: remove };
    w.__ottBrowserLocalMedia = api;
    w.addEventListener("unload", function () {
        Object.keys(urls).forEach(function (id) {
            urlApi.revokeObjectURL(urls[id]);
        });
    });
    return api;
}

/** Native shells already bundle their UI. Only HTTPS/localhost web builds install a worker. */
export function installOfflineShell(w: any): Promise<any> {
    if (
        !w.navigator.serviceWorker ||
        !w.isSecureContext ||
        w.Capacitor ||
        w.__TAURI_INTERNALS__
    )
        return Promise.resolve(null);
    if (
        w.location.protocol !== "https:" &&
        !/^localhost$|^127\.0\.0\.1$|^\[::1\]$/.test(w.location.hostname)
    )
        return Promise.resolve(null);
    // Player routes such as /f/pc/ still load the shared assets from the origin root.
    var worker = new w.URL("/offline-worker.js", w.location.href);
    return w.navigator.serviceWorker
        .register(worker.href, { scope: new w.URL("/", worker).href })
        .catch(function () {
            return null;
        });
}
