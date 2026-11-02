// Renders the link-preview assets for mcp-tasks.dev from the real UI:
//   public/og/policy-desk.png  1200x630 Open Graph image
//   docs/assets/social-preview.png  the same card at 1280x640 for GitHub's social preview
//   public/og/policy-desk.mp4  ~15 s silent loop of one refund: ask, hold, passkey, done
// The console is the real bundle on preview fixtures (scene=demo, see preview/demo.ts) and the
// approval page is the SDK's own handleApprovalRoute, so the pixels are the shipped UI. Only
// the passkey prompt is drawn here: it belongs to Auth0 and the browser, not to this app.
//   npm run og:render [-- --image-only]   (needs ffmpeg; CHROMIUM_PATH for another browser)
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chromium,
  type BrowserContextOptions,
  type Page,
  type Route,
} from "playwright-core";
import { serve } from "./serve";

const here = new URL("./", import.meta.url);
const out = new URL("../public/og/", here);
const W = 1280;
const H = 720;
const SCALE = 1.5; // 1920x1080 frames, downscaled to 1280x720 so text stays crisp

const run = (cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, { stdio: ["ignore", "ignore", "inherit"] });
  if (r.status !== 0) throw new Error(`${cmd} exited ${r.status}`);
};
run(process.execPath, [new URL("../preview/build.mjs", here).pathname]);
await mkdir(out, { recursive: true });
const { origin, token, server } = await serve();
const consoleUrl = (step = "") =>
  `${origin}/?scene=demo&lat=0&r=${encodeURIComponent(token)}${step}`;
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
});

// Fonts and the card's screenshots are served on the app's origin under /__og/ (a data URL
// over 2 MB does not load), so every page here can use Geist without a network.
const files = new Map<string, { body: Buffer; type: string }>();
const fontFile = (f: string) =>
  readFile(new URL(`../../../../node_modules/geist/dist/fonts/${f}`, here));
files.set("geist.woff2", {
  body: await fontFile("geist-sans/Geist-Variable.woff2"),
  type: "font/woff2",
});
files.set("geist-mono.woff2", {
  body: await fontFile("geist-mono/GeistMono-Variable.woff2"),
  type: "font/woff2",
});
const ogFiles = (route: Route) => {
  const f = files.get(new URL(route.request().url()).pathname.slice(6));
  return f
    ? route.fulfill({ body: f.body, contentType: f.type })
    : route.fulfill({ status: 404 });
};
const context = async (o: BrowserContextOptions) => {
  const c = await browser.newContext(o);
  await c.route(`${origin}/__og/*`, ogFiles);
  // The console's Google Fonts stylesheet, answered locally with the same Geist files.
  await c.route("https://fonts.googleapis.com/**", (route) =>
    route.fulfill({
      contentType: "text/css",
      body: `@font-face{font-family:Geist;src:url(${origin}/__og/geist.woff2) format("woff2");font-weight:100 900}
@font-face{font-family:"Geist Mono";src:url(${origin}/__og/geist-mono.woff2) format("woff2");font-weight:100 900}`,
    }),
  );
  return c;
};
// Own family names, so they never collide with the console's Google Fonts Geist.
const FONTS = `
@font-face{font-family:OgGeist;src:url(/__og/geist.woff2) format("woff2");font-weight:100 900}
@font-face{font-family:OgGeistMono;src:url(/__og/geist-mono.woff2) format("woff2");font-weight:100 900}`;
const fontsLoaded = (page: Page) =>
  page.evaluate(() =>
    Promise.all([
      document.fonts.load("700 20px OgGeist"),
      document.fonts.load("500 20px OgGeistMono"),
    ]),
  );
const MARK = `<svg viewBox="0 0 16 16" aria-hidden="true"><rect width="16" height="16" rx="3" fill="#171717"/><path d="M4 8.5l3 3 5-6" stroke="#fff" stroke-width="2" fill="none"/></svg>`;

/** Types the refund request and waits until policy has held it for a person. */
async function ask(page: Page, typeDelay: number) {
  const input = page.locator("textarea.chat-input");
  await input.click();
  await input.pressSequentially(
    "Mei Tanaka's keyboard was dead on arrival. Refund it in full.",
    { delay: typeDelay },
  );
  await page.keyboard.press("Enter");
  await page.getByRole("link", { name: "Review this refund" }).waitFor();
}

// ---------------------------------------------------------------- image
{
  // Narrow windows, so the UI is shown near its real size inside the card.
  const shots = await context({
    viewport: { width: 1040, height: 700 },
    deviceScaleFactor: 2,
  });
  const page = await shots.newPage();
  await page.goto(consoleUrl());
  await ask(page, 0);
  await page.waitForTimeout(600);
  const chat = await page.locator(".panel.chat").screenshot();
  await page.setViewportSize({ width: 600, height: 900 });
  await page.goto(`${origin}/approve?r=${encodeURIComponent(token)}`);
  await page.addStyleTag({ content: "main{padding:28px 24px 8px}" });
  const approve = await page.locator("main").screenshot();
  files.set("chat.png", { body: chat, type: "image/png" });
  files.set("approve.png", { body: approve, type: "image/png" });
  // A 1200x630 stage captured at 1x (the size Open Graph asks for), then on GitHub's
  // 1280x640 social-preview canvas, where the background simply extends.
  const card = await (
    await context({ viewport: { width: 1200, height: 630 } })
  ).newPage();
  const html = `<!doctype html><meta charset=utf-8><style>${FONTS}
*{box-sizing:border-box;margin:0}
html,body{width:100vw;height:100vh;overflow:hidden}
.stage{position:absolute;left:50%;top:50%;width:1200px;height:630px;translate:-50% -50%}
body{position:relative;background:#fafafa;color:#171717;font-family:OgGeist,sans-serif;-webkit-font-smoothing:antialiased}
.grid{position:absolute;inset:0;background-image:linear-gradient(#ebebeb 1px,transparent 1px),linear-gradient(90deg,#ebebeb 1px,transparent 1px);background-size:48px 48px;mask-image:radial-gradient(ellipse 70% 80% at 22% 40%,#000 0%,transparent 75%);opacity:.7}
.glow{position:absolute;width:620px;height:620px;right:-120px;top:-60px;background:radial-gradient(circle,rgb(0 112 243/.10),transparent 65%)}
.copy{position:absolute;left:64px;top:56px;width:500px;bottom:56px;display:flex;flex-direction:column}
.brand{display:flex;align-items:center;gap:12px;font-size:24px;font-weight:600;letter-spacing:-.02em}
.brand svg{width:30px;height:30px}
.pill{margin-top:48px;align-self:flex-start;display:flex;align-items:center;gap:8px;padding:6px 12px;border:1px solid #ebebeb;border-radius:999px;background:#fff;font-size:15px;color:#4d4d4d}
.pill i{width:7px;height:7px;border-radius:50%;background:#107d32}
h1{margin-top:22px;font-size:70px;line-height:1;font-weight:700;letter-spacing:-.055em;background:linear-gradient(180deg,#171717 40%,#4d4d4d);-webkit-background-clip:text;color:transparent;padding-bottom:6px}
p{margin-top:22px;width:470px;font-size:22px;line-height:1.42;color:#666;letter-spacing:-.01em}
.foot{margin-top:auto;display:flex;align-items:center;gap:12px;font:500 19px/1 OgGeistMono,monospace;color:#171717}
.foot span{color:#8f8f8f}
.win{position:absolute;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 0 0 1px rgb(0 0 0/.08),0 24px 48px -12px rgb(0 0 0/.18),0 8px 16px -8px rgb(0 0 0/.08)}
.win img{display:block;width:100%}
.chat{left:620px;top:48px;width:548px;height:300px}
.approve{left:596px;top:316px;width:348px;height:340px;background:#fafafa}
</style>
<div class=grid></div><div class=glow></div>
<div class=stage>
<div class=copy>
  <div class=brand>${MARK}Policy Desk</div>
  <div class=pill><i></i>MCP Tasks with Auth0 approvals</div>
  <h1>Agents ask.<br>People approve.</h1>
  <p>Policy decides when an AI agent's refund needs a person. You approve that exact operation with a passkey.</p>
  <div class=foot>mcp-tasks.dev<span>· open source reference</span></div>
</div>
<div class="win chat"><img src="/__og/chat.png"></div>
<div class="win approve"><img src="/__og/approve.png"></div>
</div>`;
  files.set("card.html", { body: Buffer.from(html), type: "text/html" });
  await card.goto(`${origin}/__og/card.html`);
  await fontsLoaded(card);
  await card.waitForLoadState("load");
  await card.screenshot({ path: new URL("policy-desk.png", out).pathname });
  await card.setViewportSize({ width: 1280, height: 640 });
  const social = new URL("../../../../docs/assets/social-preview.png", here);
  await card.screenshot({ path: social.pathname });
  await card.context().close();
  await shots.close();
  console.log(
    "wrote public/og/policy-desk.png, docs/assets/social-preview.png",
  );
}

// ---------------------------------------------------------------- video
if (!process.argv.includes("--image-only")) {
  const frames = await mkdtemp(join(tmpdir(), "og-frames-"));
  const page = await (
    await context({
      viewport: { width: W, height: H },
      deviceScaleFactor: SCALE,
    })
  ).newPage();
  // A visible pointer and a step caption, re-added after each navigation.
  let cursor = { x: 900, y: 600 };
  let caption = "";
  const OVERLAY = `${FONTS}
#og-cursor{position:fixed;z-index:99999;left:0;top:0;width:22px;height:22px;pointer-events:none;transition:transform .55s cubic-bezier(.3,.7,.2,1);filter:drop-shadow(0 1px 2px rgb(0 0 0/.35))}
#og-cursor.press{scale:.86}
#og-cap{position:fixed;z-index:99998;right:24px;bottom:24px;display:flex;align-items:center;gap:10px;padding:10px 16px 10px 10px;border-radius:999px;background:#171717;color:#fff;font:500 15px/1 OgGeist,sans-serif;letter-spacing:-.01em;box-shadow:0 8px 24px rgb(0 0 0/.18);transition:opacity .25s,translate .25s}
#og-cap b{display:grid;place-items:center;width:22px;height:22px;border-radius:50%;background:#fff;color:#171717;font:600 12px/1 OgGeistMono,monospace}
#og-cap.hide{opacity:0;translate:0 6px}`;
  const overlay = () =>
    page.evaluate(
      ({ css, x, y, cap }) => {
        if (document.getElementById("og-cursor")) return;
        const s = document.createElement("style");
        s.textContent = css;
        document.head.append(s);
        const c = document.createElement("div");
        c.id = "og-cursor";
        c.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22"><path d="M5 3l14 8-6 1.6L10 19z" fill="#171717" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
        c.style.transform = `translate(${x}px,${y}px)`;
        const p = document.createElement("div");
        p.id = "og-cap";
        p.className = cap ? "" : "hide";
        p.innerHTML = cap;
        document.body.append(c, p);
        return document.fonts.load("500 15px OgGeist").catch(() => {});
      },
      { css: OVERLAY, x: cursor.x, y: cursor.y, cap: caption },
    );
  const say = async (n: number, text: string) => {
    caption = `<b>${n}</b>${text}`;
    await page.evaluate((cap) => {
      const p = document.getElementById("og-cap")!;
      p.classList.add("hide");
      setTimeout(() => {
        p.innerHTML = cap;
        p.classList.remove("hide");
      }, 220);
    }, caption);
  };
  const moveTo = async (selector: string, dx = 0.5, dy = 0.6) => {
    const box = (await page.locator(selector).first().boundingBox())!;
    cursor = { x: box.x + box.width * dx, y: box.y + box.height * dy };
    await page.evaluate(
      ({ x, y }) =>
        (document.getElementById("og-cursor")!.style.transform =
          `translate(${x}px,${y}px)`),
      cursor,
    );
    await page.waitForTimeout(650);
  };
  const press = async () => {
    await page.evaluate(() =>
      document.getElementById("og-cursor")!.classList.add("press"),
    );
    await page.waitForTimeout(140);
  };

  // Load the first view before recording, so the clip opens on a finished page.
  await page.goto(consoleUrl());
  await page.locator("textarea.chat-input").waitFor();
  await page.waitForTimeout(800);
  await overlay();

  const cdp = await page.context().newCDPSession(page);
  const shots: { file: string; t: number }[] = [];
  cdp.on("Page.screencastFrame", async (f) => {
    const file = join(frames, `${String(shots.length).padStart(5, "0")}.jpg`);
    shots.push({ file, t: f.metadata.timestamp ?? Date.now() / 1000 });
    await writeFile(file, Buffer.from(f.data, "base64"));
    await cdp
      .send("Page.screencastFrameAck", { sessionId: f.sessionId })
      .catch(() => {});
  });
  const record = () =>
    cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: 92,
      maxWidth: W * SCALE,
      maxHeight: H * SCALE,
      everyNthFrame: 1,
    });
  await record();
  const t0 = Date.now() / 1000;

  // 1. The agent asks.
  await page.waitForTimeout(400);
  await say(1, "Ask the agent to refund $139");
  await moveTo("textarea.chat-input", 0.3, 0.5);
  await ask(page, 28);
  // 2. Policy holds it for a person.
  await say(2, "Policy holds it for a person");
  await page.waitForTimeout(1300);
  await moveTo("a.btn.primary.small", 0.5, 0.6);
  await press();
  // 3. The approval page, from the signed link.
  await page.getByRole("link", { name: "Review this refund" }).click();
  await page.waitForLoadState("domcontentloaded");
  // A little larger than 1:1, since the page is a narrow column in a wide frame.
  await page.addStyleTag({ content: "body>header,body>main{zoom:1.2}" });
  await overlay();
  await say(3, "You approve that exact refund");
  await page.waitForTimeout(700);
  await moveTo("button.primary", 0.5, 0.6);
  await press();
  // The passkey prompt itself is Auth0's and the browser's; draw a neutral stand-in.
  await page.evaluate((css) => {
    const s = document.createElement("style");
    s.textContent = `${css}
#og-pk{position:fixed;inset:0;z-index:99990;display:grid;place-items:center;background:rgb(0 0 0/.0);transition:background .3s}
#og-pk.on{background:rgb(0 0 0/.28)}
#og-pk .sheet{width:340px;padding:28px 28px 24px;border-radius:16px;background:#fff;text-align:center;font-family:OgGeist,sans-serif;box-shadow:0 24px 64px rgb(0 0 0/.25);opacity:0;translate:0 12px;transition:opacity .3s,translate .3s}
#og-pk.on .sheet{opacity:1;translate:0 0}
#og-pk .ic{width:64px;height:64px;margin:0 auto 16px;border-radius:50%;display:grid;place-items:center;background:#ebf5ff;color:#0070f3;transition:background .3s,color .3s}
#og-pk.ok .ic{background:#ebfaef;color:#107d32}
#og-pk h2{font-size:18px;font-weight:600;letter-spacing:-.02em}
#og-pk p{margin-top:6px;font-size:14px;color:#666;line-height:1.45}
#og-pk .ic svg{width:34px;height:34px}
#og-pk .ok-i{display:none}#og-pk.ok .ok-i{display:block}#og-pk.ok .fp{display:none}`;
    document.head.append(s);
    const d = document.createElement("div");
    d.id = "og-pk";
    d.innerHTML = `<div class=sheet><div class=ic>
<svg class=fp viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M12 11v4.5M8.5 9.6a4 4 0 0 1 7 2.4v1.5M7.9 14.5c.1 1.8-.3 3.4-1 4.6M16 15.5c0 1.6-.3 3-.9 4.2M12 7a6 6 0 0 0-6 6v.5M18 13a6 6 0 0 0-2.1-4.6M9.9 20.5c.7-1.4 1.1-3 1.1-4.8"/></svg>
<svg class=ok-i viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>
</div><h2>Confirm with your passkey</h2><p>Auth0 checks it is you, for refund:create on payment:ORD-1042 only.</p></div>`;
    document.body.append(d);
    requestAnimationFrame(() => d.classList.add("on"));
  }, FONTS);
  await page.waitForTimeout(1400);
  await page.evaluate(() => {
    const d = document.getElementById("og-pk")!;
    d.classList.add("ok");
    d.querySelector("h2")!.textContent = "Approved";
    d.querySelector("p")!.textContent =
      "Signed by your passkey and bound to this exact refund.";
  });
  await page.waitForTimeout(1000);
  // 4. Back in the console the held refund has run.
  await page.goto(consoleUrl("&step=done"));
  await page.getByText("Refunded").first().waitFor();
  await overlay();
  await say(4, "The agent finishes the refund");
  await page.waitForTimeout(2400);
  await cdp.send("Page.stopScreencast");
  const t1 = Date.now() / 1000;
  await page.close();

  // Each frame lasts until the next; the last one until the end of the take.
  const list = shots
    .filter((s) => s.t >= t0 - 0.05)
    .map((s, i, a) => {
      const until = a[i + 1]?.t ?? t1;
      return `file '${s.file}'\nduration ${Math.max(0.001, until - s.t).toFixed(4)}`;
    });
  const listFile = join(frames, "frames.txt");
  await writeFile(
    listFile,
    `ffconcat version 1.0\n${list.join("\n")}\nfile '${shots.at(-1)!.file}'\n`,
  );
  run("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listFile,
    "-vf",
    `fps=30,scale=${W}:${H}:flags=lanczos,format=yuv420p`,
    "-c:v",
    "libx264",
    "-preset",
    "slow",
    "-crf",
    "24",
    "-profile:v",
    "high",
    "-movflags",
    "+faststart",
    "-an",
    new URL("policy-desk.mp4", out).pathname,
  ]);
  await rm(frames, { recursive: true, force: true });
  console.log(
    `wrote public/og/policy-desk.mp4 (${(t1 - t0).toFixed(1)} s, ${shots.length} frames)`,
  );
}

await browser.close();
server.close();
