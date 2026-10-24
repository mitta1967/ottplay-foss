/** Bounded playback feedback; transport retries remain owned by the engine. */
(function (host: any): void {
    var media: HTMLVideoElement | null = null;
    var active = false;
    var expired = false;
    var timer: ReturnType<typeof setTimeout> | null = null;
    var armed = false;
    var source = "";
    var position = 0;
    var sampledAt = 0;
    var refreshInfo: (() => void) | undefined;
    function sourceKey(): string {
        return media ? media.src + "\n" + media.currentSrc : "";
    }
    function sample(): void {
        source = sourceKey();
        position = media ? media.currentTime : 0;
        sampledAt = Date.now();
    }
    function progressing(): boolean {
        if (!active || !media) return false;
        if (source !== sourceKey()) {
            armed = true;
            sample();
            return false;
        }
        var next = media.currentTime;
        var elapsed = (Date.now() - sampledAt) / 1000;
        var delta = next - position;
        var rate = Math.abs(media.playbackRate || 1);
        var advanced =
            armed &&
            !media.seeking &&
            !media.paused &&
            !media.ended &&
            delta > 0 &&
            delta <= elapsed * rate + 2;
        sample();
        return advanced;
    }
    function observe(): void {
        if (progressing() && (timer || expired)) {
            clear();
            expired = false;
            render("", false);
        }
    }
    function clear(): void {
        clearTimeout(timer!);
        timer = null;
    }
    function render(message: string, busy: boolean): void {
        // Keep status inside the existing metadata column. Its normal footer
        // timeout owns visibility; media events must not reopen the footer.
        var spinner = document.getElementById("buffering");
        var label = document.getElementById("video_res");
        if (spinner) spinner.style.display = busy ? "block" : "none";
        if (!label) return;
        label.className = message ? "playback-feedback" : "";
        label.textContent = message && expired ? host._("ERROR!") : message;
        label.title = message;
        if (message) label.setAttribute("aria-label", message);
        else label.removeAttribute("aria-label");
        if (!message && refreshInfo) refreshInfo();
    }
    function fail(message?: string): void {
        clear();
        expired = true;
        render(
            message || host._("Stream timed out. Select the channel to retry."),
            false
        );
    }
    function waiting(message: string, deadline: number): void {
        if (!active) {
            render("", false);
            return;
        }
        if (expired) {
            fail();
            return;
        }
        render(message, true);
        // Repeated progress/waiting/retry events must not extend the deadline.
        if (!timer) {
            sample();
            timer = setTimeout(function () {
                observe();
                if (active && timer) fail();
            }, deadline);
        }
    }
    function begin(paused?: boolean, resuming?: boolean): void {
        if (paused) return stop();
        clear();
        active = true;
        expired = false;
        // begin runs before the previous source is detached. Its remaining
        // frames cannot acknowledge the replacement source's startup.
        armed = !!resuming;
        sample();
        waiting(host._("Connecting..."), 30000);
    }
    function stop(): void {
        active = false;
        expired = false;
        clear();
        render("", false);
    }
    host.__ottPlaybackFeedback = {
        begin: begin,
        bind: function (next: HTMLVideoElement, refresh?: () => void): void {
            if (media === next) return;
            media = next;
            refreshInfo = refresh;
            function on(name: string, action: () => void): void {
                next.addEventListener(name, function () {
                    if (media === next) action();
                });
            }
            on("loadstart", function () {
                armed = true;
                sample();
                waiting(host._("Connecting..."), 30000);
            });
            function buffering(): void {
                waiting(host._("Buffering..."), 45000);
            }
            on("waiting", buffering);
            on("stalled", buffering);
            on("timeupdate", observe);
            on("seeking", sample);
            on("seeked", sample);
            on("pause", function () {
                // Engine preparation also pauses media: only explicit pause intent
                // cancels feedback. A late preparation event cannot cancel startup.
                if (host.forcePlay === false) stop();
            });
            on("play", function () {
                if (!active && host.forcePlay !== false) begin(false, true);
            });
            on("ended", stop);
        },
        fail: function (): void {
            if (active) fail(host._("Stream could not be played"));
        },
        inactive: function (): boolean {
            return !active;
        },
        retry: function (): void {
            waiting(host._("Retrying..."), 30000);
        },
        stop: stop,
        visible: function (): boolean {
            return active && !!(timer || expired);
        },
    };
})(window as any);
