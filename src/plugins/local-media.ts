import {
    installBrowserLocalMedia,
    installOfflineShell,
} from "../offline/browser-local-media";
import { resolveNativePlugin, tauriInvoke } from "./native-bridge";

/** Stable item IDs belong to storage; playback URLs are resolved anew each launch. */
export function installLocalMedia(w: any): any {
    if (w.__ottLocalMedia) return w.__ottLocalMedia;
    var browser = installBrowserLocalMedia(w);
    installOfflineShell(w);
    var native = resolveNativePlugin<any>("LocalMedia", function () {
        return browser;
    });
    var opened = false;
    var revision = 0;
    var handler: any = null;
    var last: any = null;
    var endpoint = "";
    function isNative(): boolean {
        return !!(
            w.Capacitor &&
            w.Capacitor.isNativePlatform &&
            w.Capacitor.isNativePlatform()
        );
    }
    function isTauri(): boolean {
        return !!(w.__TAURI__ || w.__TAURI_INTERNALS__);
    }
    function remoteEndpoint(): string {
        try {
            return String(
                w.stbGetItem ? w.stbGetItem("localMediaEndpoint") || "" : ""
            );
        } catch (_) {
            return "";
        }
    }
    function getEndpoint(): Promise<string> {
        if (isTauri())
            return tauriInvoke<any>("offline_media_endpoint", {}).then(
                function (value) {
                    endpoint = value.endpoint;
                    return endpoint;
                }
            );
        endpoint = remoteEndpoint().replace(/\/+$/, "");
        return Promise.resolve(endpoint);
    }
    function http(url: string, options?: any): Promise<any> {
        return w.fetch(url, options).then(function (response: any) {
            if (!response.ok)
                throw new Error(
                    "Local media request failed (" + response.status + ")"
                );
            return response.json().then(function (value: any) {
                if (value && Array.isArray(value.items))
                    value.items.forEach(function (item: any) {
                        if (item.url) item.url = new URL(item.url, url).href;
                    });
                if (value && value.uploadUrl)
                    value.uploadUrl = new URL(value.uploadUrl, url).href;
                return value;
            });
        });
    }
    function remember(value: any): any {
        if (!value || !Array.isArray(value.items))
            throw new Error("Invalid local media catalog");
        last = value;
        return value;
    }
    function list(): Promise<any> {
        if (isNative()) return native.list().then(remember);
        return getEndpoint()
            .then(function (base) {
                return base ? http(base) : browser.list();
            })
            .then(remember);
    }
    function importFiles(folder = false): Promise<any> {
        if (locked() || settingsLocked())
            return Promise.reject(
                new Error(
                    "Unlock settings and kiosk mode to change local sources"
                )
            );
        if (isNative())
            return (folder ? native.importFolder() : native.importFiles()).then(
                remember
            );
        if (isTauri())
            return tauriInvoke<any>(
                folder
                    ? "offline_media_import_folder"
                    : "offline_media_import_files",
                {}
            ).then(function () {
                return list();
            });
        if (remoteEndpoint())
            return Promise.reject(
                new Error(
                    "Connect folders on the server itself, or select this device's library."
                )
            );
        return (folder ? browser.importFolder() : browser.importFiles()).then(
            remember
        );
    }
    function removeSource(id: string): Promise<any> {
        if (locked() || settingsLocked())
            return Promise.reject(
                new Error("Unlock settings to disconnect sources")
            );
        if (isNative()) return native.removeSource({ id: id }).then(remember);
        if (isTauri())
            return tauriInvoke<any>("offline_media_remove_source", {
                id: id,
            }).then(function () {
                return list();
            });
        if (remoteEndpoint())
            return Promise.reject(
                new Error("Manage sources on the server itself.")
            );
        return browser.removeSource(id).then(remember);
    }
    function requestAccess(): Promise<any> {
        if (locked() || settingsLocked())
            return Promise.reject(new Error("Unlock settings to grant access"));
        if (isNative()) return native.requestAccess().then(remember);
        if (isTauri()) {
            var missing =
                last &&
                (last.sources || []).filter(function (source: any) {
                    return !source.available;
                })[0];
            return importFiles(!!missing && missing.kind === "folder");
        }
        if (remoteEndpoint()) return list();
        return browser.requestAccess().then(remember);
    }
    function remove(id: string): Promise<any> {
        if (locked())
            return Promise.reject(
                new Error("Unlock kiosk mode to change local files")
            );
        if (settingsLocked())
            return Promise.reject(
                new Error("Unlock settings to change local files")
            );
        if (isNative()) return native.remove({ id: id }).then(remember);
        return getEndpoint()
            .then(function (base) {
                return base
                    ? http(base + "/" + encodeURIComponent(id), {
                          method: "DELETE",
                      })
                    : browser.remove(id);
            })
            .then(remember);
    }
    function title(): string {
        return w._ ? w._("Local videos") : "Local videos";
    }
    function locked(): boolean {
        return !!(w.__ottKiosk && w.__ottKiosk.locked());
    }
    function settingsLocked(): boolean {
        return !!(w.__ottParental && w.__ottParental.needs("settings"));
    }
    function text(value: any): string {
        return String(value == null ? "" : value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }
    function current(): boolean {
        return opened && (!handler || w.listKeyHandler === handler);
    }
    function close(): void {
        opened = false;
        revision++;
        if (typeof w.optionsList === "function") w.optionsList(w.popLocalMedia);
        else if (typeof w.closeList === "function") w.closeList();
    }
    function playable(): boolean {
        return !!(
            last &&
            last.items.some(function (item: any) {
                return item.available !== false && !!item.url;
            })
        );
    }
    function activate(): void {
        if (locked()) return;
        if (!playable()) {
            open();
            return;
        }
        opened = false;
        revision++;
        if (typeof w.closeList === "function") w.closeList();
        w.stbSetItem("ottplayprov", "offline");
        w.loadProv("offline");
    }
    function editServer(): void {
        revision++;
        w.editCaption = w._("Server library URL");
        w.editvar = remoteEndpoint();
        w.setEdit = function () {
            if (!current() || locked() || settingsLocked()) return;
            var value = String(w.editvar || "")
                .trim()
                .replace(/\/+$/, "");
            if (value && !/^https?:\/\//i.test(value)) {
                render("Use an HTTP or HTTPS URL.");
                return;
            }
            w.stbSetItem("localMediaEndpoint", value);
            run(list);
        };
        w.showEditKey(null);
    }
    function render(message?: string): void {
        if (!current()) return;
        if (locked()) {
            close();
            return;
        }
        var selected = w.selIndex || 0;
        var rows: any[] = [];
        function row(
            id: string,
            name: string,
            description: string,
            action: () => void
        ): void {
            rows.push({
                action: action,
                description: description,
                id: id,
                name: name,
            });
        }
        row(
            "add-folder",
            "Add folder",
            "Play files directly from the selected folder without copying them.",
            function () {
                run(function () {
                    return importFiles(true);
                });
            }
        );
        row(
            "add-files",
            "Add files",
            "Play selected files directly without copying them.",
            function () {
                run(function () {
                    return importFiles();
                });
            }
        );
        if (
            last &&
            (last.sources || []).some(function (source: any) {
                return !source.available;
            })
        )
            row(
                "grant-access",
                "Grant access",
                "Allow access to previously connected sources.",
                function () {
                    run(requestAccess);
                }
            );
        row("refresh", "Refresh", "Read connected folders again.", function () {
            run(list);
        });
        row(
            "play",
            "Play local videos",
            playable()
                ? "Open the local video channel list."
                : "No playable local videos. Add a folder or grant access to a connected source.",
            function () {
                if (playable()) activate();
            }
        );
        ((last && last.sources) || []).forEach(function (source: any) {
            row(
                "disconnect-source",
                "Disconnect: " + source.name,
                (source.available ? "Connected. " : "Source unavailable. ") +
                    "Disconnecting leaves the original files untouched.",
                function () {
                    run(function () {
                        return removeSource(source.id);
                    });
                }
            );
        });
        ((last && last.items) || []).forEach(function (item: any) {
            if (item.source === "linked") return;
            row(
                "remove-copy",
                "Remove copy: " + item.name,
                "Remove this previously imported copy from the library.",
                function () {
                    run(function () {
                        return remove(item.id);
                    });
                }
            );
        });
        if (!isNative() && !isTauri())
            row(
                "server-library",
                "Server library…",
                remoteEndpoint()
                    ? "A server library is selected. Clear its URL to use files on this device."
                    : "Optional: connect a library stored on your server. Network access is required.",
                editServer
            );
        row("close", "Close", "Return to player settings.", close);
        w.listArray = rows;
        w.listDataArray = rows;
        w.selIndex = Math.min(selected, rows.length - 1);
        w.getListItem = function (item: any) {
            return (
                '&nbsp;&nbsp;<span data-local-media-action="' +
                item.id +
                '">' +
                text(w._ ? w._(item.name) : item.name) +
                "</span>"
            );
        };
        w.detailListAction = function () {
            var item = rows[w.selIndex];
            w.listDetail.innerHTML = text(
                message || (item && item.description) || ""
            );
            w.listFooter.innerHTML =
                w.renderButtonHint(w.keys.RETURN, w.strRETURN, "Close") +
                w.renderButtonHint(w.keys.ENTER, w.strENTER, "Select");
        };
        handler = function (key: number) {
            if (!current()) return false;
            if (key === w.keys.RETURN) {
                close();
                return true;
            }
            if (key !== w.keys.ENTER) return false;
            var item = rows[w.selIndex];
            if (item) item.action();
            return true;
        };
        w.listKeyHandler = handler;
        w.listCaption.innerHTML = text(title());
        w.$("#listPopUp").hide();
        w.showPage();
    }
    function run(action: () => Promise<any>): void {
        var request = ++revision;
        // Start the picker inside the user gesture, before rendering or awaiting.
        var pending: Promise<any>;
        try {
            pending = action();
        } catch (error: any) {
            render(error.message || String(error));
            return;
        }
        render("Working…");
        pending.then(
            function () {
                if (request === revision) render();
            },
            function (error) {
                if (request === revision)
                    render(error.message || String(error));
            }
        );
    }
    function open(): void {
        if (locked()) return;
        if (settingsLocked()) {
            if (typeof w.enterPinAndSetAccess === "function")
                w.enterPinAndSetAccess(open);
            return;
        }
        opened = true;
        handler = null;
        w.selIndex = 0;
        render();
        run(list);
    }
    var api = {
        activate: activate,
        available: function () {
            return isNative() || isTauri() || !!w.indexedDB;
        },
        importFiles: importFiles,
        isPlaybackUrl: function (url: string) {
            return !!(
                last &&
                last.items.some(function (item: any) {
                    return item.url === url;
                })
            );
        },
        list: list,
        open: open,
        remove: remove,
        title: title,
    };
    w.__ottLocalMedia = api;
    w.popLocalMedia = open;
    return api;
}
