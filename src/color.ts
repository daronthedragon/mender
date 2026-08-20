const enabled =
  process.env["NO_COLOR"] === undefined &&
  process.env["TERM"] !== "dumb" &&
  Boolean(process.stdout.isTTY);

const wrap = (code: string) => (s: string) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : s);

export const green = wrap("32");
export const red = wrap("31");
export const yellow = wrap("33");
export const blue = wrap("36");
export const dim = wrap("2");
export const bold = wrap("1");
