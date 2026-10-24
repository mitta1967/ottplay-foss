import type {
    CommandServerRequest,
    CommandServerResponse,
} from "./command-server";

var sessionSequence = 0;

/** Optional, ephemeral banners. Failure must never interrupt remote control. */
export function createRemoteNotifications(
    w: any,
    send: (
        request: CommandServerRequest,
        complete: (response?: CommandServerResponse) => void
    ) => () => void
): any {
    var address = "";
    var token = "";
    var runtime = "";
    var generation = 0;
    var activityEpoch = 0;
    var lastActive = false;
    var cancel: (() => void) | null = null;
    var pending = false;
    var nextPoll = 0;
    var seen: Record<string, boolean> = Object.create(null);
    var order: string[] = [];
    var banners: Array<{ element: any; timer: any }> = [];

    function clearBanner(banner: { element: any; timer: any }): void {
        w.clearTimeout(banner.timer);
        if (banner.element.parentNode)
            banner.element.parentNode.removeChild(banner.element);
        var index = banners.indexOf(banner);
        if (index !== -1) banners.splice(index, 1);
    }
    function clear(): void {
        banners.slice().forEach(clearBanner);
    }
    function newSession(): void {
        // Not a secret: bind ephemeral server queues to this active viewing session.
        runtime =
            "n" +
            Date.now().toString(36) +
            "_" +
            ++sessionSequence +
            "_" +
            Math.random().toString(36).slice(2) +
            Math.random().toString(36).slice(2);
        seen = Object.create(null);
        order = [];
    }
    function suspend(): void {
        activityEpoch++;
        lastActive = false;
        // A quick sleep/wake can happen between heartbeats. Retire the server's
        // previous queue too, including events enqueued during that gap.
        newSession();
        clear();
    }
    function isActive(): boolean {
        try {
            var document = w.document;
            return !!(
                document &&
                document.hidden !== true &&
                document.visibilityState !== "hidden" &&
                !(
                    document.body && document.body.classList.contains("booting")
                ) &&
                w.__ottScreenAwake !== false &&
                !(w.__ottStandby && w.__ottStandby.blocked()) &&
                !(typeof w.stbIsStandby === "function" && w.stbIsStandby())
            );
        } catch (_error) {
            return false;
        }
    }
    function stop(): void {
        generation++;
        var abort = cancel;
        cancel = null;
        pending = false;
        nextPoll = 0;
        clear();
        if (abort) {
            try {
                abort();
            } catch (_error) {}
        }
    }
    function configure(nextAddress: string, nextToken: string): void {
        stop();
        newSession();
        lastActive = false;
        address = nextAddress;
        token = nextToken;
    }
    function integer(value: any, min: number, max: number): boolean {
        return (
            typeof value === "number" &&
            isFinite(value) &&
            Math.floor(value) === value &&
            value >= min &&
            value <= max
        );
    }
    function timestamp(value: any): boolean {
        return typeof value === "number" && isFinite(value) && value > 0;
    }
    function monotonic(): number | null {
        try {
            var value = w.performance && w.performance.now();
            return typeof value === "number" && isFinite(value) ? value : null;
        } catch (_error) {
            return null;
        }
    }
    function valid(item: any): boolean {
        return !!(
            item &&
            typeof item.id === "string" &&
            /^[a-f0-9]{32}$/.test(item.id) &&
            item.runtime === runtime &&
            typeof item.title === "string" &&
            item.title.length <= 128 &&
            typeof item.message === "string" &&
            item.message.length > 0 &&
            item.message.length <= 512 &&
            ["info", "warning", "critical"].indexOf(item.severity) !== -1 &&
            integer(item.duration_ms, 1000, 15000) &&
            timestamp(item.expires_at)
        );
    }
    function remember(id: string): void {
        seen[id] = true;
        order.push(id);
        while (order.length > 64) delete seen[order.shift()!];
    }
    function show(item: any, remaining: number): void {
        // Recheck at delivery: a screen can sleep while the request is in flight.
        if (!isActive()) return;
        var document = w.document;
        var container = document.getElementById("notifications");
        if (!container) return;
        while (banners.length >= 3) clearBanner(banners[0]);
        var element = document.createElement("div");
        element.className =
            "notify remote-notify remote-notify-" + item.severity;
        element.dir = "auto";
        element.setAttribute("role", "status");
        var icon = document.createElement("span");
        icon.className = "remote-notify-icon";
        icon.setAttribute("aria-hidden", "true");
        var content = document.createElement("div");
        content.className = "remote-notify-content";
        function addText(kind: string, value: string): void {
            var child = document.createElement("div");
            child.className = "remote-notify-" + kind;
            child.dir = "auto";
            child.textContent = value;
            content.appendChild(child);
        }
        addText(
            "label",
            item.severity === "critical"
                ? "Alert"
                : item.severity === "warning"
                  ? "Attention"
                  : "Home update"
        );
        if (item.title) addText("title", item.title);
        addText("message", item.message);
        element.appendChild(icon);
        element.appendChild(content);
        container.appendChild(element);
        var banner = { element: element, timer: null as any };
        banners.push(banner);
        banner.timer = w.setTimeout(
            function () {
                clearBanner(banner);
            },
            Math.min(item.duration_ms, remaining)
        );
    }
    function poll(): void {
        var active = isActive();
        if (!active && lastActive) suspend();
        lastActive = active;
        if (!active) clear();
        if (
            !w.document ||
            !address ||
            !token ||
            pending ||
            Date.now() < nextPoll
        )
            return;
        var started = Date.now();
        var startedMonotonic = monotonic();
        var current = generation;
        var currentActivity = activityEpoch;
        var queryIndex = address.indexOf("?");
        var base = queryIndex < 0 ? address : address.slice(0, queryIndex);
        var query = queryIndex < 0 ? "?" : address.slice(queryIndex) + "&";
        var url =
            base.replace(/\/api\/webhook\/commands$/, "/api/notifications") +
            query +
            "runtime=" +
            encodeURIComponent(runtime) +
            "&active=" +
            String(active);
        var finished = false;
        pending = true;
        nextPoll = started + 5000;
        function complete(response?: CommandServerResponse): void {
            if (finished || current !== generation) return;
            finished = true;
            pending = false;
            cancel = null;
            // Older servers and transient failures quietly back off this lane only.
            nextPoll = Date.now() + 60000;
            if (
                !response ||
                response.status !== 200 ||
                typeof response.body !== "string" ||
                response.body.length > 32768
            )
                return;
            try {
                var data = JSON.parse(response.body);
                if (
                    !data ||
                    data.version !== 1 ||
                    !timestamp(data.server_time) ||
                    !integer(data.poll_after_ms, 5000, 60000) ||
                    !Array.isArray(data.notifications) ||
                    data.notifications.length > 4
                )
                    return;
                nextPoll = Date.now() + data.poll_after_ms;
                data.notifications.forEach(function (item: any) {
                    if (!valid(item) || seen[item.id]) return;
                    // Mark dropped/expired items too; waking must not replay a stale event.
                    remember(item.id);
                    var currentMonotonic = monotonic();
                    var elapsed = Math.max(
                        0,
                        Date.now() - started,
                        startedMonotonic !== null && currentMonotonic !== null
                            ? currentMonotonic - startedMonotonic
                            : 0
                    );
                    // Wire timestamps are seconds; local deadlines use milliseconds.
                    var remaining =
                        (item.expires_at - data.server_time) * 1000 - elapsed;
                    if (
                        active &&
                        currentActivity === activityEpoch &&
                        remaining > 0
                    )
                        show(item, remaining);
                });
            } catch (_error) {}
        }
        try {
            var abort = send(
                {
                    headers: { Authorization: "Bearer " + token },
                    method: "GET",
                    timeoutMs: 8000,
                    url: url,
                },
                complete
            );
            if (!finished && current === generation) cancel = abort;
        } catch (_error) {
            complete();
        }
    }
    if (w.document && typeof w.document.addEventListener === "function")
        w.document.addEventListener("visibilitychange", function () {
            if (!isActive()) suspend();
        });
    var api = {
        configure: configure,
        poll: poll,
        stop: stop,
        suspend: suspend,
    };
    w.__ottRemoteNotifications = api;
    return api;
}
