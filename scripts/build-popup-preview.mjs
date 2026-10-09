import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// A standalone demo must not rely on siblings or the preview host's APIs.
export async function buildPopupPreview(root, version) {
  const ui = path.join(root, "ui");
  const [html, css, layout, script, web, fonts] = await Promise.all(
    ["popup.html", "popup.css", "popup-layout.js", "popup.js", "web.svg", "fonts.css"].map(file => readFile(path.join(ui, file), "utf8"))
  );
  const logo = await readFile(path.join(root, "assets", "icons", "icon-48.png"));
  const comicFont = await readFile(path.join(ui, "fonts", "bangers", "Bangers-Regular.ttf"));
  const previewFonts = fonts.replace('url("fonts/bangers/Bangers-Regular.ttf")', `url("data:font/ttf;base64,${comicFont.toString("base64")}")`);
  const inlineScript = text => `<script>${text.replace(/<\/script/gi, "<\\/script")}</script>`;
  const previewScript = script.replace(/const previewMode = !\([\s\S]*?\);/, "const previewMode = true;");
  if (previewScript === script) throw new Error("Standalone preview must explicitly use demo mode");
  const dataSvg = svg => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  const result = html.replace('<script src="popup-layout.js"></script>', inlineScript(layout))
    .replace('<link rel="stylesheet" href="fonts.css">', `<style>${previewFonts}</style>`)
    .replace('<link rel="stylesheet" href="popup.css">', `<style>${css}</style>`)
    .replace('<script src="popup.js"></script>', inlineScript(previewScript))
    .replace('src="../assets/icons/icon-48.png"', `src="data:image/png;base64,${logo.toString("base64")}"`)
    .replace('src="web.svg"', `src="${dataSvg(web)}"`);
  await mkdir(path.join(root, "dist"), { recursive: true });
  const target = path.join(root, "dist", `adlock-preview-${version}.html`);
  await writeFile(target, result);
  return target;
}
