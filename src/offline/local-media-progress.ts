/** Explain actual local-source work without implying media bytes are copied. */
export function formatLocalMediaProgress(
    value: any,
    translate: (text: string) => string
): string {
    if (value.phase === "picker-folder")
        return translate("Choose a folder in the browser window");
    if (value.phase === "picker-files")
        return translate("Choose files in the browser window");
    var playable = (value.items || []).filter(function (item: any) {
        return item.available !== false && !!item.url;
    }).length;
    var result = translate("Local videos") + ": " + playable;
    if (typeof value.discovered === "number")
        result += " · " + translate("Entries found") + ": " + value.discovered;
    if (value.phase === "enumerating") {
        result += " · " + translate("Reading folder entries");
        if (!playable)
            result +=
                " · " +
                translate(
                    "The browser checks folder metadata before returning files. Large network folders can take several minutes."
                );
    } else if (value.phase === "metadata")
        result += " · " + translate("Reading file information");
    else if (value.phase === "permission")
        result += " · " + translate("Checking folder permission");
    return result;
}

/** Native enumeration can warm network metadata even after cached playback starts. */
export function localMediaProgressTimeout(value: any): number {
    return value.phase === "enumerating" ? 2700000 : 60000;
}
