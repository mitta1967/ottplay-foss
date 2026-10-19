/** Direct local sources: new entries store handles, never copied media bytes. */
export function installBrowserLocalMedia(w: any): any {
    if (w.__ottBrowserLocalMedia) return w.__ottBrowserLocalMedia;
    var dbPromise: Promise<any> | null = null;
    var urls: any = {};
    var knownSources: any[] = [];
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
    function records(): Promise<any[]> {
        return open().then(function (db) {
            return new Promise<any[]>(function (resolve, reject) {
                var result: any[] = [],
                    tx = db.transaction("files", "readonly"),
                    cursor = tx.objectStore("files").openCursor();
                cursor.onsuccess = function () {
                    var c = cursor.result;
                    if (c) {
                        result.push(c.value);
                        c.continue();
                    }
                };
                tx.oncomplete = function () {
                    resolve(
                        result.sort(function (a, b) {
                            return (
                                a.created - b.created ||
                                a.id.localeCompare(b.id)
                            );
                        })
                    );
                };
                tx.onerror = tx.onabort = function () {
                    reject(new Error("Could not read local media sources"));
                };
            });
        });
    }
    function media(file: any): boolean {
        return (
            /^(video|audio)\//i.test(file.type || "") ||
            /\.(mp4|m4v|webm|mp3|m4a|ogg|wav|mov)$/i.test(file.name || "")
        );
    }
    function item(
        id: string,
        file: any,
        name: string,
        sourceId: string,
        live: any
    ): any {
        live[id] = true;
        var signature = file.size + ":" + file.lastModified;
        if (urls[id] && (urls[id] as any).signature !== signature) {
            urlApi.revokeObjectURL((urls[id] as any).url);
            delete urls[id];
        }
        if (!urls[id])
            (urls as any)[id] = {
                signature: signature,
                url: urlApi.createObjectURL(file),
            };
        return {
            access: "granted",
            available: true,
            id: id,
            mime: file.type || "application/octet-stream",
            name: name,
            size: file.size,
            source: sourceId.indexOf("source-") === 0 ? "linked" : "imported",
            sourceId: sourceId,
            url: (urls[id] as any).url,
        };
    }
    // Manual async iteration keeps the shipped bundle ES5 compatible.
    function walk(
        handle: any,
        prefix: string,
        sourceId: string,
        live: any
    ): Promise<any[]> {
        var iterator = handle.values(),
            result: any[] = [];
        function next(): Promise<any[]> {
            return Promise.resolve(iterator.next()).then(function (step) {
                if (step.done) return result;
                var child = step.value,
                    name = prefix + child.name;
                var work =
                    child.kind === "directory"
                        ? walk(child, name + "/", sourceId, live)
                        : child.getFile().then(function (file) {
                              return media(file)
                                  ? [
                                        item(
                                            sourceId + ":" + name,
                                            file,
                                            name,
                                            sourceId,
                                            live
                                        ),
                                    ]
                                  : [];
                          });
                return work.then(function (items) {
                    result = result.concat(items);
                    return next();
                });
            });
        }
        return next();
    }
    function list(): Promise<any> {
        if (!available)
            return Promise.resolve({
                available: false,
                directSources: false,
                items: [],
                offlineReady: false,
                sources: [],
                storage: "browser",
            });
        return records().then(function (saved) {
            knownSources = saved.filter(function (r) {
                return !!r.handle;
            });
            var live: any = {},
                sources: any[] = [];
            return Promise.all(
                saved.map(function (record): Promise<any[]> {
                    if (record.blob)
                        return Promise.resolve([
                            item(
                                record.id,
                                record.blob,
                                record.name,
                                record.id,
                                live
                            ),
                        ]);
                    var source = {
                        access: "granted",
                        available: true,
                        id: record.id,
                        kind:
                            record.handle.kind === "directory"
                                ? "folder"
                                : "file",
                        name: record.name,
                    };
                    sources.push(source);
                    return Promise.resolve(
                        record.handle.queryPermission({ mode: "read" })
                    )
                        .then(function (access) {
                            if (access !== "granted") {
                                source.access = "permission-required";
                                return [];
                            }
                            if (record.handle.kind === "directory")
                                return walk(record.handle, "", record.id, live);
                            return record.handle
                                .getFile()
                                .then(function (file) {
                                    return [
                                        item(
                                            record.id,
                                            file,
                                            file.name,
                                            record.id,
                                            live
                                        ),
                                    ];
                                });
                        })
                        .catch(function (error) {
                            source.access =
                                error && error.name === "NotAllowedError"
                                    ? "permission-required"
                                    : "missing";
                            return [];
                        })
                        .then(function (items) {
                            source.available = source.access === "granted";
                            return source.available
                                ? items
                                : [
                                      {
                                          access: source.access,
                                          available: false,
                                          id: record.id,
                                          name: record.name,
                                          size: 0,
                                          source: "linked",
                                          sourceId: record.id,
                                          url: "",
                                      },
                                  ];
                        });
                })
            ).then(function (groups) {
                var items: any[] = [];
                groups.forEach(function (group) {
                    items = items.concat(group);
                });
                Object.keys(urls).forEach(function (id) {
                    if (!live[id]) {
                        urlApi.revokeObjectURL((urls[id] as any).url);
                        delete urls[id];
                    }
                });
                return {
                    available: true,
                    directSources: !!w.showDirectoryPicker,
                    items: items,
                    offlineReady: !!(
                        w.navigator.serviceWorker &&
                        w.navigator.serviceWorker.controller &&
                        /\/offline-worker\.js(?:[?#]|$)/.test(
                            w.navigator.serviceWorker.controller.scriptURL
                        )
                    ),
                    persistent: false,
                    sources: sources,
                    storage: "browser",
                };
            });
        });
    }
    function save(handles: any[]): Promise<any> {
        return open()
            .then(function (db) {
                return new Promise(function (resolve, reject) {
                    var tx = db.transaction("files", "readwrite");
                    handles.forEach(function (handle, index) {
                        tx.objectStore("files").add({
                            created: Date.now(),
                            handle: handle,
                            id:
                                "source-" +
                                Date.now().toString(36) +
                                "-" +
                                index +
                                "-" +
                                Math.random().toString(36).slice(2),
                            name: handle.name,
                        });
                    });
                    tx.oncomplete = function () {
                        resolve(null);
                    };
                    tx.onerror = tx.onabort = function () {
                        reject(
                            new Error("Could not save local source permissions")
                        );
                    };
                });
            })
            .then(list);
    }
    function cancelled(error: any): Promise<any> {
        if (error && error.name === "AbortError") return list();
        return Promise.reject(error);
    }
    function importFiles(files?: any): Promise<any> {
        if (files)
            return Promise.reject(
                new Error(
                    "Direct sources require the file picker; media copying is disabled"
                )
            );
        if (!w.showOpenFilePicker)
            return Promise.reject(
                new Error(
                    "Direct file access is unavailable in this browser. Use Chrome or Edge on desktop, or the Android app."
                )
            );
        return w
            .showOpenFilePicker({
                multiple: true,
                types: [
                    {
                        accept: {
                            "audio/*": [".mp3", ".m4a", ".ogg", ".wav"],
                            "video/*": [".mp4", ".m4v", ".webm", ".mov"],
                        },
                        description: "Video and audio",
                    },
                ],
            })
            .then(function (handles: any[]) {
                return Promise.all(
                    handles.map(function (handle) {
                        return handle.getFile().then(function (file) {
                            if (!media(file))
                                throw new Error(
                                    "Choose supported video or audio files"
                                );
                            return handle;
                        });
                    })
                );
            })
            .then(save)
            .catch(cancelled);
    }
    function importFolder(): Promise<any> {
        if (!w.showDirectoryPicker)
            return Promise.reject(
                new Error(
                    "Direct folder access is unavailable in this browser. Use Chrome or Edge on desktop, or the Android app."
                )
            );
        return w
            .showDirectoryPicker({ mode: "read" })
            .then(function (handle) {
                return save([handle]);
            })
            .catch(cancelled);
    }
    function requestAccess(): Promise<any> {
        // list() cached these handles. Invoke permission synchronously in the click turn.
        return Promise.all(
            knownSources.map(function (r) {
                return r.handle
                    .requestPermission({ mode: "read" })
                    .catch(function () {
                        return "denied";
                    });
            })
        ).then(list);
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
    var api = {
        importFiles: importFiles,
        importFolder: importFolder,
        list: list,
        remove: remove,
        removeSource: remove,
        requestAccess: requestAccess,
    };
    w.__ottBrowserLocalMedia = api;
    w.addEventListener("unload", function () {
        Object.keys(urls).forEach(function (id) {
            urlApi.revokeObjectURL((urls[id] as any).url);
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
