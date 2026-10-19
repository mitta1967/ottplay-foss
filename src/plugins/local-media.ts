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
    var panel: HTMLElement | null = null;
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
                        item.url = new URL(item.url, url).href;
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
    function chooseFiles(): Promise<File[]> {
        return new Promise(function (resolve) {
            var input = w.document.createElement("input");
            var done = false;
            input.type = "file";
            input.accept = "video/*,audio/*,.mp4,.m4v,.webm,.mp3,.m4a";
            input.multiple = true;
            input.style.display = "none";
            function finish(): void {
                if (done) return;
                done = true;
                w.removeEventListener("focus", focus);
                if (input.parentNode) input.parentNode.removeChild(input);
                resolve(Array.prototype.slice.call(input.files || []));
            }
            function focus(): void {
                w.setTimeout(function () {
                    if (!done && !input.files.length) finish();
                }, 1000);
            }
            input.onchange = finish;
            input.addEventListener("cancel", finish);
            w.addEventListener("focus", focus);
            w.document.body.appendChild(input);
            input.click();
        });
    }
    function importFiles(): Promise<any> {
        if (locked())
            return Promise.reject(
                new Error("Unlock kiosk mode to change local files")
            );
        if (settingsLocked())
            return Promise.reject(
                new Error("Unlock settings to change local files")
            );
        if (isNative()) return native.importFiles().then(remember);
        if (!isTauri() && !remoteEndpoint())
            return browser.importFiles().then(remember);
        return chooseFiles().then(function (files) {
            return getEndpoint().then(function (base) {
                var queue = Promise.resolve(last);
                files.forEach(function (file) {
                    queue = queue.then(function () {
                        return http(
                            base +
                                "/import?name=" +
                                encodeURIComponent(file.name),
                            { body: file, method: "POST" }
                        );
                    });
                });
                return queue.then(function () {
                    return list();
                });
            });
        });
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
    function stopKey(event: KeyboardEvent): void {
        if (panel) event.stopImmediatePropagation();
    }
    function close(): void {
        if (panel) panel.remove();
        panel = null;
        w.document.removeEventListener("keydown", onKey, true);
        w.document.removeEventListener("keyup", stopKey, true);
    }
    function onKey(event: KeyboardEvent): void {
        if (!panel) return;
        if (locked()) {
            close();
            return;
        }
        if (
            event.key === "Escape" ||
            event.keyCode === 10009 ||
            event.keyCode === 461
        ) {
            event.preventDefault();
            close();
        }
        if (
            event.key === "ArrowDown" ||
            event.key === "ArrowRight" ||
            event.key === "ArrowUp" ||
            event.key === "ArrowLeft"
        ) {
            var buttons = Array.prototype.slice.call(
                panel.querySelectorAll("button:not(:disabled)")
            );
            var current = buttons.indexOf(w.document.activeElement);
            var delta =
                event.key === "ArrowDown" || event.key === "ArrowRight"
                    ? 1
                    : -1;
            if (buttons.length)
                buttons[
                    (current + delta + buttons.length) % buttons.length
                ].focus();
            event.preventDefault();
        }
        event.stopImmediatePropagation();
    }
    function activate(): void {
        if (locked()) return;
        if (!last || !last.items.length) {
            open();
            return;
        }
        close();
        w.stbSetItem("ottplayprov", "offline");
        w.loadProv("offline");
    }
    function button(
        parent: HTMLElement,
        caption: string,
        action: () => void
    ): HTMLButtonElement {
        var element = w.document.createElement("button");
        element.textContent = caption;
        element.style.cssText =
            "padding:12px 18px;margin:6px;font:inherit;background:#24364e;color:white;border:1px solid #60748c;border-radius:8px;cursor:pointer";
        element.onclick = action;
        parent.appendChild(element);
        return element;
    }
    function render(message?: string): void {
        if (!panel) return;
        if (locked()) {
            close();
            return;
        }
        var focusedCaption = panel.contains(w.document.activeElement)
            ? w.document.activeElement.textContent
            : "";
        panel.textContent = "";
        var heading = w.document.createElement("h2");
        heading.textContent = title();
        panel.appendChild(heading);
        var note = w.document.createElement("p");
        note.textContent =
            message ||
            (last && last.storage === "server"
                ? "Files are stored on the server. A connection to that server is required."
                : "Files are stored on this device. MP4 with H.264/AAC is recommended.");
        panel.appendChild(note);
        if (last && !last.items.length) {
            var empty = w.document.createElement("p");
            empty.setAttribute("role", "status");
            empty.textContent =
                "No local videos yet. Choose Add files to import videos, then choose Play local videos.";
            panel.appendChild(empty);
        }
        if (last && last.storage === "browser") {
            var scope = w.document.createElement("p");
            scope.textContent =
                "This library belongs to this website and browser profile. Videos on your Mac, other devices, or another website are not added automatically.";
            panel.appendChild(scope);
        }
        button(panel, "Add files", function () {
            run(importFiles);
        });
        var play = button(panel, "Play local videos", activate);
        play.disabled = !last || !last.items.length;
        if (play.disabled) {
            play.style.opacity = "0.5";
            play.style.cursor = "default";
        }
        button(panel, "Refresh", function () {
            run(list);
        });
        button(panel, "Close", close);
        if (last && last.storage === "browser" && !last.offlineReady) {
            var ready = w.document.createElement("p");
            ready.textContent =
                "Offline restart is not ready. Keep this page open until the app download completes; HTTPS or localhost is required.";
            panel.appendChild(ready);
        }
        if (last && last.storage === "browser" && !last.persistent) {
            var warning = w.document.createElement("p");
            warning.textContent =
                "Browser storage is not protected from eviction. Keep a backup; clearing site data removes these files.";
            panel.appendChild(warning);
        }
        if (!isNative() && !isTauri()) {
            button(panel, "Server library…", function () {
                var value = w.prompt(
                    "Optional server library URL (leave empty for files on this device)",
                    remoteEndpoint()
                );
                if (value === null) return;
                value = value.trim().replace(/\/+$/, "");
                if (value && !/^https?:\/\//i.test(value)) {
                    render("Use an HTTP or HTTPS URL.");
                    return;
                }
                w.stbSetItem("localMediaEndpoint", value);
                run(list);
            });
        }
        ((last && last.items) || []).forEach(function (item: any) {
            var row = w.document.createElement("div");
            row.style.cssText = "padding:8px;border-bottom:1px solid #334155";
            var text = w.document.createElement("span");
            text.textContent =
                item.name + " — " + (item.size / 1048576).toFixed(1) + " MiB";
            row.appendChild(text);
            button(row, "Remove", function () {
                if (w.confirm("Remove “" + item.name + "” from local storage?"))
                    run(function () {
                        return remove(item.id);
                    });
            });
            panel!.appendChild(row);
        });
        var enabled = panel.querySelectorAll("button:not(:disabled)");
        var focusTarget = enabled[0] as HTMLElement;
        for (var focusIndex = 0; focusIndex < enabled.length; focusIndex++)
            if (enabled[focusIndex].textContent === focusedCaption)
                focusTarget = enabled[focusIndex] as HTMLElement;
        if (focusTarget) focusTarget.focus();
    }
    function run(action: () => Promise<any>): void {
        render("Working…");
        action().then(
            function () {
                render();
            },
            function (error) {
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
        close();
        panel = w.document.createElement("section");
        panel!.setAttribute("role", "dialog");
        panel!.setAttribute("aria-label", title());
        panel!.style.cssText =
            "position:fixed;top:0;right:0;bottom:0;left:0;z-index:2147483000;overflow:auto;padding:4vh 5vw;background:#101b2b;color:#eef4ff;font:20px sans-serif";
        panel!.addEventListener("click", function (event) {
            event.stopPropagation();
        });
        w.document.body.appendChild(panel!);
        w.document.addEventListener("keydown", onKey, true);
        w.document.addEventListener("keyup", stopKey, true);
        run(list);
        var first = panel!.querySelector("button");
        if (first) first.focus();
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
