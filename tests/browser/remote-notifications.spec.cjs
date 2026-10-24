// Exercise the shipped player and its actual transport/DOM; no HA or real devices.
const { test, expect } = require("../helpers/browser-test.cjs");

test("active player renders a literal banner and standby removes it immediately", async ({
    page,
    context,
    baseURL,
}) => {
    const origin = new URL(baseURL).origin;
    const polls = [];
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) return route.abort("blockedbyclient");
        if (url.pathname === "/ha-control/api/notifications") {
            const active = url.searchParams.get("active") === "true";
            const runtime = url.searchParams.get("runtime");
            polls.push({ active, runtime });
            const now = Date.now() / 1000;
            return route.fulfill({
                json: {
                    notifications:
                        active && polls.length === 1
                            ? [
                                  {
                                      duration_ms: 15000,
                                      expires_at: now + 15,
                                      id: "a".repeat(32),
                                      message:
                                          '<img src=x onerror="bad()"> Door opened',
                                      runtime,
                                      severity: "critical",
                                      title: "Home Assistant",
                                  },
                              ]
                            : [],
                    poll_after_ms: 5000,
                    server_time: now,
                    version: 1,
                },
            });
        }
        if (url.pathname.startsWith("/ha-control/"))
            return route.fulfill({
                json: { commands: [], server_time: Date.now() / 1000 },
            });
        return route.continue();
    });
    await context.routeWebSocket("**/*", (socket) => socket.close());
    await page.goto("/f/pc/");
    await page.waitForFunction(
        () =>
            !!window.__ottCommandServer &&
            !document.body.classList.contains("booting")
    );
    await page.evaluate((address) => {
        window.__ottCommandServer.configure({
            address,
            enabled: true,
            token: "notification_fixture_" + "b".repeat(32),
        });
    }, origin + "/ha-control");
    const banner = page.locator(".remote-notify");
    await expect(banner).toBeVisible();
    await expect(banner).toHaveText(
        'Home Assistant\n<img src=x onerror="bad()"> Door opened'
    );
    await expect(banner.locator("img")).toHaveCount(0);
    await expect(banner).toHaveCSS("border-left-color", "rgb(239, 83, 80)");
    await expect(banner).toHaveCSS("pointer-events", "none");
    await expect(banner).toHaveCSS("white-space", "pre-wrap");
    await page.evaluate(() => window.__ottStandby.set(true));
    await expect(banner).toHaveCount(0);
    await expect.poll(() => polls.some((poll) => !poll.active)).toBe(true);
    expect(
        await page.evaluate(() => window.__ottCommandServer.status().state)
    ).toBe("connected");
    expect(polls.at(-1).runtime).not.toBe(polls[0].runtime);
    expect(errors).toEqual([]);
});
