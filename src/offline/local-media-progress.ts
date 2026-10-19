/** Counts describe catalog work, never bytes downloaded or copied. */
export function formatLocalMediaProgress(
    value: any,
    translate: (text: string) => string
): string {
    var scanned = Math.max(0, Math.floor(Number(value.scanned) || 0));
    if (!isFinite(scanned)) scanned = 0;
    var total = Number(value.total);
    var known =
        value.total != null &&
        isFinite(total) &&
        total >= scanned &&
        Math.floor(total) === total;
    var playable = (value.items || []).filter(function (item: any) {
        return item.available !== false && !!item.url;
    }).length;
    return (
        translate("Loading. Please wait...") +
        " (" +
        scanned +
        (known ? " / " + total : "") +
        ") · " +
        translate("Local videos") +
        ": " +
        playable
    );
}
