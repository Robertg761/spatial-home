// Colour conversions for simulated lights. Home Assistant reports a lamp's colour as both
// `rgb_color` and `hs_color`, so a command in one form has to fill in the other.

export type Rgb = [number, number, number];
export type Hs = [number, number];

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Hue in degrees and saturation in percent, rounded to the precision Home Assistant reports. */
export function rgbToHs([r, g, b]: Rgb): Hs {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const delta = max - Math.min(red, green, blue);
  let hue = 0;
  if (delta !== 0) {
    if (max === red) hue = ((green - blue) / delta) % 6;
    else if (max === green) hue = (blue - red) / delta + 2;
    else hue = (red - green) / delta + 4;
  }
  const saturation = max === 0 ? 0 : delta / max;
  return [
    Math.round(((hue * 60 + 360) % 360) * 1000) / 1000,
    Math.round(saturation * 100000) / 1000,
  ];
}

/** The brightest colour with this hue and saturation; brightness is a separate attribute. */
export function hsToRgb([hue, saturation]: Hs): Rgb {
  const s = clamp(saturation, 0, 100) / 100;
  const h = (((hue % 360) + 360) % 360) / 60;
  const x = 1 - Math.abs((h % 2) - 1);
  const [r, g, b] = [
    [1, x, 0],
    [x, 1, 0],
    [0, 1, x],
    [0, x, 1],
    [x, 0, 1],
    [1, 0, x],
  ][Math.min(5, Math.floor(h))] as [number, number, number];
  const mix = (channel: number) => Math.round((channel * s + (1 - s)) * 255);
  return [mix(r), mix(g), mix(b)];
}

/** An approximate RGB for a white of the given colour temperature (Tanner Helland's fit). */
export function kelvinToRgb(kelvin: number): Rgb {
  const t = clamp(kelvin, 1000, 40000) / 100;
  const red = t <= 66 ? 255 : 329.698727446 * (t - 60) ** -0.1332047592;
  const green =
    t <= 66
      ? 99.4708025861 * Math.log(t) - 161.1195681661
      : 288.1221695283 * (t - 60) ** -0.0755148492;
  const blue = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  return [red, green, blue].map((channel) => Math.round(clamp(channel, 0, 255))) as Rgb;
}
