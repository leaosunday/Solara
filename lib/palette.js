const { decode: decodeJpeg } = require('./jpeg-decoder');

const MAX_DIMENSION = 96;
const TARGET_SAMPLE_COUNT = 2400;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function componentToHex(value) {
  const clamped = clamp(Math.round(value), 0, 255);
  return clamped.toString(16).padStart(2, "0");
}

function rgbToHex({ r, g, b }) {
  return `#${componentToHex(r)}${componentToHex(g)}${componentToHex(b)}`;
}

function rgbToHsl(r, g, b) {
  const rNorm = clamp(r / 255, 0, 1);
  const gNorm = clamp(g / 255, 0, 1);
  const bNorm = clamp(b / 255, 0, 1);

  const max = Math.max(rNorm, gNorm, bNorm);
  const min = Math.min(rNorm, gNorm, bNorm);
  const delta = max - min;

  let h = 0;
  if (delta !== 0) {
    if (max === rNorm) {
      h = ((gNorm - bNorm) / delta) % 6;
    } else if (max === gNorm) {
      h = (bNorm - rNorm) / delta + 2;
    } else {
      h = (rNorm - gNorm) / delta + 4;
    }
    h *= 60;
    if (h < 0) h += 360;
  }

  const l = (max + min) / 2;
  const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));

  return { h, s, l };
}

function hueToRgb(p, q, t) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function hslToRgb(h, s, l) {
  const saturation = clamp(s, 0, 1);
  const lightness = clamp(l, 0, 1);
  const normalizedHue = ((h % 360) + 360) % 360 / 360;

  if (saturation === 0) {
    const value = lightness * 255;
    return { r: value, g: value, b: value };
  }

  const q = lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;

  const r = hueToRgb(p, q, normalizedHue + 1 / 3) * 255;
  const g = hueToRgb(p, q, normalizedHue) * 255;
  const b = hueToRgb(p, q, normalizedHue - 1 / 3) * 255;

  return { r, g, b };
}

function hslToHex(color) {
  const rgb = hslToRgb(color.h, color.s, color.l);
  return rgbToHex(rgb);
}

function relativeLuminance(r, g, b) {
  const normalize = (value) => {
    const channel = clamp(value / 255, 0, 1);
    return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * normalize(r) + 0.7152 * normalize(g) + 0.0722 * normalize(b);
}

function pickContrastColor(color) {
  const luminance = relativeLuminance(color.r, color.g, color.b);
  return luminance > 0.45 ? "#1f2937" : "#f8fafc";
}

function adjustSaturation(base, factor, offset = 0) {
  return clamp(base * factor + offset, 0, 1);
}

function adjustLightness(base, offset, factor = 1) {
  return clamp(base * factor + offset, 0, 1);
}

function analyzeImageColors(image) {
  const { data } = image;
  const totalPixels = data.length / 4;
  const step = Math.max(1, Math.floor(totalPixels / TARGET_SAMPLE_COUNT));

  let totalR = 0, totalG = 0, totalB = 0, count = 0;
  let accent = null;

  for (let index = 0; index < data.length; index += step * 4) {
    const alpha = data[index + 3];
    if (alpha < 48) continue;

    const r = data[index], g = data[index + 1], b = data[index + 2];
    totalR += r; totalG += g; totalB += b;
    count++;

    const hsl = rgbToHsl(r, g, b);
    const score = hsl.s * 0.65 + (1 - Math.abs(hsl.l - 0.5)) * 0.35;

    if (!accent || score > accent.score) accent = { color: hsl, score };
  }

  if (count === 0) throw new Error("No opaque pixels available for analysis");

  const average = rgbToHsl(totalR / count, totalG / count, totalB / count);
  const accentColor = accent ? accent.color : average;

  return { average, accent: accentColor };
}

function buildGradientStops(accent) {
  const lightColors = [
    hslToHex({ h: accent.h, s: adjustSaturation(accent.s, 0.4, 0.08), l: adjustLightness(accent.l, 0.42, 0.52) }),
    hslToHex({ h: accent.h, s: adjustSaturation(accent.s, 0.52, 0.05), l: adjustLightness(accent.l, 0.26, 0.62) }),
    hslToHex({ h: accent.h, s: adjustSaturation(accent.s, 0.65), l: adjustLightness(accent.l, 0.12, 0.72) }),
  ];

  const darkColors = [
    hslToHex({ h: accent.h, s: adjustSaturation(accent.s, 0.55, 0.04), l: adjustLightness(accent.l, 0.14, 0.38) }),
    hslToHex({ h: accent.h, s: adjustSaturation(accent.s, 0.62, 0.02), l: adjustLightness(accent.l, 0.04, 0.3) }),
    hslToHex({ h: accent.h, s: adjustSaturation(accent.s, 0.72), l: adjustLightness(accent.l, -0.04, 0.22) }),
  ];

  return {
    light: { colors: lightColors, gradient: `linear-gradient(140deg, ${lightColors[0]} 0%, ${lightColors[1]} 45%, ${lightColors[2]} 100%)` },
    dark: { colors: darkColors, gradient: `linear-gradient(135deg, ${darkColors[0]} 0%, ${darkColors[1]} 55%, ${darkColors[2]} 100%)` },
  };
}

function buildThemeTokens(accent) {
  return {
    light: {
      primaryColor: hslToHex({ h: accent.h, s: adjustSaturation(accent.s, 0.6, 0.06), l: adjustLightness(accent.l, 0.22, 0.6) }),
      primaryColorDark: hslToHex({ h: accent.h, s: adjustSaturation(accent.s, 0.72, 0.02), l: adjustLightness(accent.l, 0.06, 0.52) }),
    },
    dark: {
      primaryColor: hslToHex({ h: accent.h, s: adjustSaturation(accent.s, 0.58, 0.04), l: adjustLightness(accent.l, 0.16, 0.42) }),
      primaryColorDark: hslToHex({ h: accent.h, s: adjustSaturation(accent.s, 0.68), l: adjustLightness(accent.l, 0.02, 0.32) }),
    },
  };
}

function resizeImage(image) {
  const maxSide = Math.max(image.width, image.height);
  if (maxSide <= MAX_DIMENSION) return image;

  const scale = MAX_DIMENSION / maxSide;
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const resized = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y++) {
    const srcY = Math.min(image.height - 1, Math.floor(y / scale));
    for (let x = 0; x < width; x++) {
      const srcX = Math.min(image.width - 1, Math.floor(x / scale));
      const srcIndex = (srcY * image.width + srcX) * 4;
      const destIndex = (y * width + x) * 4;
      resized[destIndex] = image.data[srcIndex];
      resized[destIndex + 1] = image.data[srcIndex + 1];
      resized[destIndex + 2] = image.data[srcIndex + 2];
      resized[destIndex + 3] = image.data[srcIndex + 3];
    }
  }
  return { width, height, data: resized };
}

async function buildPalette(buffer, contentType) {
  // 检查是否为图片，如果不是则跳过调色板生成
  if (!contentType || !contentType.startsWith('image/')) {
    console.warn(`Skipping palette generation: unsupported content type ${contentType}`);
    return getDefaultPalette();
  }

  try {
    const decoded = decodeJpeg(buffer, { useTArray: true, formatAsRGBA: true });
    const image = resizeImage({ width: decoded.width, height: decoded.height, data: new Uint8ClampedArray(decoded.data) });
    const analyzed = analyzeImageColors(image);
    const gradientStops = buildGradientStops(analyzed.accent);
    const tokens = buildThemeTokens(analyzed.accent);
    const accentRgb = hslToRgb(analyzed.accent.h, analyzed.accent.s, analyzed.accent.l);

    return {
      source: "",
      baseColor: hslToHex(analyzed.accent),
      averageColor: hslToHex(analyzed.average),
      accentColor: hslToHex(analyzed.accent),
      contrastColor: pickContrastColor(accentRgb),
      gradients: { light: gradientStops.light, dark: gradientStops.dark },
      tokens,
    };
  } catch (error) {
    console.warn('Palette generation failed, using default:', error.message);
    return getDefaultPalette();
  }
}

function getDefaultPalette() {
  const defaultAccent = { h: 210, s: 0.5, l: 0.5 }; // 默认蓝色
  const average = { h: 210, s: 0.2, l: 0.8 };
  const gradientStops = buildGradientStops(defaultAccent);
  const tokens = buildThemeTokens(defaultAccent);
  const accentRgb = hslToRgb(defaultAccent.h, defaultAccent.s, defaultAccent.l);

  return {
    source: "",
    baseColor: "#3b82f6",
    averageColor: "#e5e7eb",
    accentColor: "#3b82f6",
    contrastColor: "#ffffff",
    gradients: { light: gradientStops.light, dark: gradientStops.dark },
    tokens,
  };
}

module.exports = { buildPalette };
