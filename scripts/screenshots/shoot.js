// Captures README screenshots of the demo build with headless Chrome.
// Runs inside the zenika/alpine-chrome:with-puppeteer container started by scripts/screenshots.sh.
const puppeteer = require("puppeteer");
const BASE = "http://localhost:4321";
const THEME = process.env.THEME || "dark";
const SHOTS = [
  { name: "dashboard", path: "/" },
  { name: "services", path: "/services" },
  { name: "clusters", path: "/clusters" },
  { name: "nodes", path: "/nodes" },
  { name: "events", path: "/events" },
  { name: "channels", path: "/channels" },
];

(async () => {
  const browser = await puppeteer.launch({
    executablePath: "/usr/bin/chromium-browser",
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: THEME }]);
  await page.evaluateOnNewDocument((theme) => localStorage.setItem("keepwatch-theme", theme), THEME);

  for (const s of SHOTS) {
    await page.goto(BASE + s.path, { waitUntil: "networkidle0" });
    // The screenshots show the app, not the demo banner.
    await page.addStyleTag({
      content:
        "body, body *:not(code):not(pre) { font-family: Inter, sans-serif !important; } " +
        "[data-demo-banner] { display: none !important; }",
    });
    await new Promise((r) => setTimeout(r, 1500));
    await page.screenshot({ path: `/out/${s.name}.png` });
    console.log("saved", s.name);
  }
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
