const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const code = ts.transpileModule(
    fs.readFileSync("src/commands/remote-handoff.ts", "utf8"),
    {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES5,
        },
    }
).outputText;
require("acorn").parse(code, { ecmaVersion: 5 });
const ctx = { exports: {} };
vm.runInNewContext(code, ctx);
let plays = [],
    locked = false;
const now = Math.floor(Date.now() / 1000);
const state = {
    generation: 1,
    phase: "playing",
    position: 30,
    target: { channelId: "7", kind: "live", sourceId: "xtream@account" },
};
const host = {
    __ottActiveProviderDriver: { id: "xtream" },
    __ottClassicArchive: { open: (value) => plays.push(["archive", value]) },
    __ottClassicPlayback: { snapshot: () => state },
    __ottParental: { needs: () => locked },
    __ottSourceIdentity: { current: () => "xtream@account" },
    cats: { all: [7] },
    catsArray: ["all"],
    channels: {
        7: {
            channel_name: "Fixture",
            itemId: "xtream:stream:100",
            rec: 24,
            url: "https://secret.invalid",
        },
    },
    getArchiveUrl: () => "https://target-resolved.invalid/archive",
    parentalArray: [],
    playChannel: (category, index) => plays.push(["live", category, index]),
    setCurrent: (category, index) => plays.push(["select", category, index]),
};
function call(action, params) {
    let result;
    ctx.exports.executeRemoteHandoff(
        host,
        { action: "playback_handoff_" + action, params },
        (value) => {
            result = value;
        }
    );
    return JSON.parse(JSON.stringify(result));
}
const exported = call("export", {});
assert.equal(exported.status, "ok");
assert(!JSON.stringify(exported).includes("secret"));
const handoff = exported.data.handoff;
assert.equal(call("import", { handoff }).status, "ok");
assert.deepEqual(plays, [["live", 0, 0]]);
assert.equal(
    call("import", { handoff: { ...handoff, source_id: "other" } }).data.error,
    "source_mismatch"
);
assert.equal(
    call("import", { handoff: { ...handoff, url: "https://evil.invalid" } })
        .data.error,
    "invalid_request"
);
assert.equal(
    call("import", { handoff: { ...handoff, item_id: "я".repeat(257) } }).data
        .error,
    "invalid_request"
);
assert.equal(
    call("import", { handoff: { ...handoff, item_id: "\ud800" } }).data.error,
    "invalid_request"
);
host.channels[8] = { ...host.channels[7] };
assert.equal(call("import", { handoff }).data.error, "ambiguous_item");
delete host.channels[8];
host.parentalArray = [7];
locked = true;
assert.equal(call("import", { handoff }).data.error, "policy_denied");
locked = false;
state.target.kind = "archive";
state.target.archiveStart = now - 300;
const archive = call("export", {}).data.handoff;
assert.equal(archive.archive_start, now - 270);
assert.equal(call("import", { handoff: archive }).status, "ok");
assert.deepEqual(plays.slice(-2), [
    ["select", 0, 0],
    ["archive", now - 270],
]);
const beforeFailedResolution = plays.length;
host.getArchiveUrl = () => "";
assert.equal(
    call("import", { handoff: archive }).data.error,
    "item_unavailable"
);
assert.equal(
    plays.length,
    beforeFailedResolution,
    "An unavailable archive must not mutate selection or acknowledge dispatch"
);
host.getArchiveUrl = () => {
    throw Error("private provider error");
};
assert.deepEqual(call("import", { handoff: archive }), {
    data: { error: "playback_failed" },
    status: "rejected",
});
assert.equal(plays.length, beforeFailedResolution);
host.getArchiveUrl = () => "https://target-resolved.invalid/archive";
assert.equal(
    call("import", { handoff: { ...archive, archive_start: now + 60 } }).data
        .error,
    "item_unavailable"
);
state.target.kind = "vod";
assert.equal(call("export", {}).data.error, "no_current_item");
host.__ottKiosk = { enabled: () => true };
assert.equal(call("import", { handoff }).data.error, "policy_denied");
console.log(
    "PASS handoff: exact source and unique stable ID, fresh target dispatch, archive position/window, kiosk/PIN, redaction"
);
