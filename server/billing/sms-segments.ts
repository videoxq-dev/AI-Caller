export type SmsEncoding = "GSM-7" | "UCS-2";

const GSM_BASIC = new Set(Array.from(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà",
));
const GSM_EXTENDED = new Set(Array.from("^{}\\[~]|€"));

function gsmSeptets(text: string) {
  let units = 0;
  for (const character of Array.from(text)) {
    if (GSM_BASIC.has(character)) units += 1;
    else if (GSM_EXTENDED.has(character)) units += 2;
    else return null;
  }
  return units;
}

export function analyzeSmsSegments(text: string): {
  encoding: SmsEncoding;
  units: number;
  segments: number;
} {
  const septets = gsmSeptets(text);
  if (septets !== null) {
    return {
      encoding: "GSM-7",
      units: septets,
      segments: septets <= 160 ? 1 : Math.ceil(septets / 153),
    };
  }

  const codeUnits = text.length;
  return {
    encoding: "UCS-2",
    units: codeUnits,
    segments: codeUnits <= 70 ? 1 : Math.ceil(codeUnits / 67),
  };
}
