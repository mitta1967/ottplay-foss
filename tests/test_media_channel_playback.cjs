const assert = require("node:assert/strict");
const { fixture, sourceFunctions } = require("./test_port_vod.cjs");
const vm = require("node:vm");

function setup(provider = "plex") {
    const c = fixture();
    const pending = [];
    c.p_pref = provider;
    c.__ottActiveProviderDriver = {
        capabilities: { mediaPlaylist: true },
        id: provider,
    };
    c.channels = {};
    c.cats = { All: [101, 102, 103] };
    c.catsArray = ["All"];
    c.curList = c.cats.All;
    c.cList = c.curList;
    c.__ottChannels = {
        capture: () => ({
            active: () => c.__ottActiveProviderDriver.id === provider,
            category: () => 0,
            members: () => c.cats.All.slice(),
        }),
        group: () => "system:all",
        select() {},
    };
    for (const id of c.cats.All)
        c.channels[id] = {
            __ottMediaItem: {
                id,
                request: { id },
                title: "Film " + id,
            },
            channel_name: "Film " + id,
        };
    c.ifParentalAccessChId = () => false;
    c.getChannelUrl = () => "";
    c.channelsList = () => c.calls.push(["channels"]);
    c.playChannel = c._playChannel;
    c.stbPlay = (url, position) => {
        c.calls.push(["play", url, position]);
        c.__ottClassicPlayback.command({ type: "playing" });
    };
    c.providerMediaClient = {
        cancel() {},
        cancelAutomatic() {},
        resolve(item, done) {
            pending.push({ done, item });
        },
        stableRequests: true,
    };
    function resolve(index = pending.length - 1) {
        const { item, done } = pending[index];
        done({ ...item, stream_url: "film-" + item.id + ".mp4" });
    }
    function end() {
        c.__ottClassicPlayback.command({ type: "stop" });
        c.__ottMedia.ended(c.__ottClassicPlayback.snapshot().generation);
    }
    return { c, end, pending, resolve };
}

for (const provider of ["plex", "vportal"]) {
    const { c, pending, resolve, end } = setup(provider);
    assert.equal(c._playChannel(0, 1), true);
    assert.equal(pending.length, 1);
    assert.match(c.elements["#dialogbox"].innerHTML, /ott-spinner/);
    assert.equal(c.calls.filter(([kind]) => kind === "play").length, 0);
    resolve();
    assert.equal(c.elements["#dialogbox"].style.display, "none");
    assert.equal(c.primaryIndex, 1);
    assert.equal(c.curList[c.primaryIndex], 102);
    const state = c.__ottClassicPlayback.snapshot();
    assert.equal(state.target.kind, "vod");
    assert.equal(state.target.channelId, "provider:102");
    assert.equal(state.historyTarget.kind, "live");
    assert.equal(state.historyTarget.channelId, "102");
    assert.equal(c.playType, -99999999999);
    assert.equal(c.__ottMedia.kioskSelection(), null);
    vm.runInContext(
        sourceFunctions("src/key-handler/index.ts", [
            "handleMainKey",
            "keyFun",
            "toggleMainPlayback",
        ]),
        c
    );
    const seeks = [];
    c.shiftArchive = (seconds) => seeks.push(seconds);
    c.settings.alFun = 14;
    c.settings.arFun = 13;
    for (const key of [c.keys.LEFT, c.keys.RIGHT])
        c.handleMainKey(key, { preventDefault() {}, stopPropagation() {} });
    assert.deepEqual(seeks, [-10, 10]);

    // The same list owns reshuffling and incrementally published entries.
    c.cats.All = [102, 103, 101, 104];
    c.curList = c.cats.All;
    c.primaryIndex = 0;
    c.channels[104] = {
        __ottMediaItem: { id: 104, request: { id: 104 }, title: "Added film" },
    };
    c.handleMainKey(c.keys.UP, { preventDefault() {}, stopPropagation() {} });
    assert.equal(pending.at(-1).item.id, 103);
    resolve();
    assert.equal(c.primaryIndex, 1);
    c.handleMainKey(c.keys.DOWN, { preventDefault() {}, stopPropagation() {} });
    assert.equal(pending.at(-1).item.id, 102);
    resolve();
    c._playChannel(0, 2);
    resolve();
    c.isListVisible = true;
    const closes = c.calls.filter(([kind]) => kind === "close").length;
    end();
    assert.equal(
        c.calls.filter(([kind]) => kind === "close").length,
        closes,
        "natural completion leaves a reopened channel list open"
    );
    c.isListVisible = false;
    assert.equal(
        pending.at(-1).item.id,
        104,
        "EOS observes newly appended rows"
    );
    resolve();
    end();
    assert.equal(pending.at(-1).item.id, 102, "repeat all wraps current order");
    resolve();
    c.__ottMedia.cycleRepeat();
    assert.equal(c.__ottMedia.repeatMode(), "one");
    end();
    assert.equal(pending.at(-1).item.id, 102);
    resolve();
    c.__ottMedia.cycleRepeat();
    assert.equal(c.__ottMedia.repeatMode(), "off");
    c._playChannel(0, 3);
    resolve();
    const count = pending.length;
    end();
    assert.equal(pending.length, count, "repeat off stops at final row");
    console.log(
        "PASS " +
            provider +
            " channel playback, loading, selection, dynamic order and repeat"
    );
}

{
    const { c, pending, resolve } = setup();
    c._playChannel(0, 0);
    c.dialogBoxKeyHandler(c.keys.RETURN);
    resolve();
    assert.equal(c.calls.filter(([kind]) => kind === "play").length, 0);
    assert(c.calls.some(([kind]) => kind === "channels"));
    c._playChannel(0, 1);
    c._playChannel(0, 2);
    resolve(1);
    assert.equal(c.calls.filter(([kind]) => kind === "play").length, 0);
    resolve(2);
    assert.equal(c.calls.filter(([kind]) => kind === "play").length, 1);
    assert.equal(c.__ottMedia.current().payload.id, 103);
    assert.equal(pending.length, 3);
    console.log(
        "PASS channel cancellation and replacement reject stale resolvers"
    );
}

{
    const { c, pending, resolve, end } = setup();
    c._playChannel(0, 0);
    resolve();
    c._playChannel(0, 1);
    end();
    assert.equal(
        pending.length,
        2,
        "old EOS does not replace pending selection"
    );
    resolve();
    assert.equal(c.__ottMedia.current().payload.id, 102);
    assert.equal(c.__ottClassicPlayback.snapshot().phase, "playing");
    console.log("PASS old decoder EOS preserves selected pending channel");
}

{
    const { c, resolve } = setup();
    c.parentalArray = [];
    const priorIndex = c.primaryIndex;
    assert.equal(
        c._playChannel(0, 1, true, () => c.primaryIndex === priorIndex),
        true
    );
    resolve();
    assert.equal(
        c.__ottMedia.current().payload.id,
        102,
        "relative command admission applies before committing its new selection"
    );
    console.log(
        "PASS relative channel admission is not reused after selection commits"
    );
}

{
    const { c, resolve, end, pending } = setup();
    c.__ottKiosk = {
        admit: (id) => id === 102,
        allowed: (id) => id === 102,
        allowedMedia: () => false,
        enabled: () => true,
        locked: () => true,
    };
    assert.equal(c._playChannel(0, 1), true);
    resolve();
    assert.equal(c.__ottMedia.current().payload.id, 102);
    assert.equal(c._playChannel(0, 0), undefined);
    end();
    assert.equal(
        pending.at(-1).item.id,
        102,
        "pinned channel loops without attempting another file"
    );
    resolve();
    assert.equal(c.__ottClassicPlayback.snapshot().phase, "playing");
    console.log("PASS channel kiosk admission and immediate pinned replay");
}

for (const provider of ["plex", "vportal"]) {
    const seed = setup(provider);
    const positions = [137.25, 248.5, 369.75];
    for (let index = 0; index < positions.length; index++) {
        seed.c._playChannel(0, index);
        seed.resolve();
        seed.c.__ottClassicPlayback.command({
            position: positions[index],
            type: "position",
        });
        seed.c.__ottMedia.checkpoint(
            seed.c.__ottMedia.current().ref,
            positions[index],
            true
        );
    }
    const cold = setup(provider);
    Object.assign(cold.c.stored, seed.c.stored);
    cold.c.commandChannelsReady = false;
    cold.c._playChannel(0, 1);
    cold.resolve();
    assert.equal(
        cold.c.calls.filter(([kind]) => kind === "play").at(-1)[2],
        positions[1],
        "startup resumes the selected file at its exact persisted position"
    );
    assert.equal(cold.c.calls.filter(([kind]) => kind === "confirm").length, 0);

    const kiosk = setup(provider);
    Object.assign(kiosk.c.stored, seed.c.stored);
    kiosk.c.commandChannelsReady = true;
    kiosk.c.__ottKiosk = {
        admit: (id) => id === 102,
        allowed: (id) => id === 102,
        allowedMedia: () => false,
        enabled: () => true,
        locked: () => true,
    };
    kiosk.c._playChannel(0, 1);
    kiosk.resolve();
    assert.equal(
        kiosk.c.calls.filter(([kind]) => kind === "play").at(-1)[2],
        positions[1],
        "kiosk recovery resumes its pinned file at the exact saved position"
    );
    assert.equal(
        kiosk.c.calls.filter(([kind]) => kind === "confirm").length,
        0
    );
    kiosk.end();
    kiosk.resolve();
    assert.equal(
        kiosk.c.calls.filter(([kind]) => kind === "play").at(-1)[2],
        0,
        "natural kiosk replay starts at zero instead of restoring position"
    );
    assert.equal(
        kiosk.c.calls.filter(([kind]) => kind === "confirm").length,
        0
    );

    const manual = setup(provider);
    Object.assign(manual.c.stored, seed.c.stored);
    manual.c.commandChannelsReady = true;
    let confirm;
    let prompts = 0;
    manual.c.confirmBox = (_message, yes) => {
        confirm = yes;
        prompts++;
    };
    manual.c._playChannel(0, 1);
    manual.resolve();
    assert.equal(prompts, 1, "ordinary selection retains Continue watching");
    confirm();
    assert.equal(
        manual.c.calls.filter(([kind]) => kind === "seek").at(-1)[1],
        manual.c.OttPlayCore.mediaResumePosition(positions[1], 60)
    );
    manual.c.__ottMedia.skip(1);
    manual.resolve();
    assert.equal(prompts, 1, "next file never opens a resume prompt");
    assert.equal(
        manual.c.calls.filter(([kind]) => kind === "play").at(-1)[2],
        0,
        "next file starts at zero despite its saved history"
    );
    manual.end();
    manual.resolve();
    assert.equal(prompts, 1, "natural completion never opens a resume prompt");
    assert.equal(
        manual.c.calls.filter(([kind]) => kind === "play").at(-1)[2],
        0
    );

    for (const natural of [true, false]) {
        const locked = setup(provider);
        Object.assign(locked.c.stored, seed.c.stored);
        locked.c.commandChannelsReady = false;
        locked.c._playChannel(0, 0);
        locked.resolve();
        locked.c.commandChannelsReady = true;
        locked.c.isListVisible = true;
        let unlock;
        locked.c.ifParentalAccessChId = (_id, next) => {
            unlock = next;
            return true;
        };
        const closes = locked.c.calls.filter(
            ([kind]) => kind === "close"
        ).length;
        if (natural) locked.end();
        else locked.c.__ottMedia.skip(1);
        assert.equal(locked.pending.length, 1, "PIN defers the next file");
        assert.equal(typeof unlock, "function");
        locked.c.ifParentalAccessChId = () => false;
        unlock();
        assert.equal(locked.pending.at(-1).item.id, 102);
        locked.resolve();
        assert.equal(
            locked.c.calls.filter(([kind]) => kind === "play").at(-1)[2],
            0,
            "PIN continuation preserves start-at-zero for the next file"
        );
        assert.equal(
            locked.c.calls.filter(([kind]) => kind === "confirm").length,
            0,
            "PIN continuation must not turn an advance into a resume prompt"
        );
        const after = locked.c.calls.filter(
            ([kind]) => kind === "close"
        ).length;
        if (natural)
            assert.equal(
                after,
                closes,
                "background advance keeps the list open after PIN"
            );
        else assert(after > closes, "arrow advance opens fullscreen after PIN");
    }
    console.log(
        "PASS " +
            provider +
            " exact startup resume, manual resume prompt, and fresh automatic/arrow playback"
    );
}
