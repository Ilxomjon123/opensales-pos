const sharp = require("sharp");
const S = 1024;       // canvas
const M = 60;         // shaffof tashqi padding (macOS uslubi)
const sq = S - M * 2; // squircle o'lcham
const R = Math.round(sq * 0.235);
(async () => {
  // logo-dark (qora fon + oq S) ni squircle o'lchamiga keltirib, radiusli mask
  const base = await sharp("logo-icon-src.png").resize(sq, sq, { fit: "cover" }).toBuffer();
  const mask = Buffer.from(
    `<svg width="${sq}" height="${sq}"><rect width="${sq}" height="${sq}" rx="${R}" ry="${R}" fill="#fff"/></svg>`
  );
  const rounded = await sharp(base)
    .composite([{ input: mask, blend: "dest-in" }])
    .png()
    .toBuffer();
  await sharp({ create: { width: S, height: S, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: rounded, gravity: "centre" }])
    .png()
    .toFile("icon-source.png");
  console.log("icon-source.png (logo-dark + squircle) yangilandi");
})().catch((e) => { console.error(e.message); process.exit(1); });
