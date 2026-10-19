/**
 * Pure arithmetic, unit, and currency helpers for the launcher. No eval/Function/
 * vm: expressions are parsed with a small recursive-descent tokenizer/parser.
 */

export interface MathResult {
  value: number;
  display: string;
}

export interface ConversionResult {
  display: string;
  value: number;
  from: string;
  to: string;
}

/** Format a number with ~10 significant digits and no floating-point noise. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return "0";
  const rounded = Number(value.toPrecision(10));
  if (Number.isInteger(rounded) && Math.abs(rounded) < 1e15) {
    return String(rounded);
  }
  let text = String(rounded);
  // String() may still emit exponential noise for extreme magnitudes; keep it.
  if (text.includes("e") || text.includes("E")) return text;
  // Trim trailing zeros left by toPrecision rounding.
  if (text.includes(".")) {
    text = text.replace(/0+$/, "").replace(/\.$/, "");
  }
  return text;
}

type Token =
  | { type: "number"; value: number }
  | { type: "op"; value: string }
  | { type: "ident"; value: string }
  | { type: "lparen" }
  | { type: "rparen" };

const FUNCTIONS: Record<string, (x: number) => number> = {
  sqrt: Math.sqrt,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  abs: Math.abs,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
};

const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
};

function normalizeExpression(text: string): string {
  return text
    .replace(/\u00d7/g, "*")
    .replace(/\u00f7/g, "/")
    .replace(/[\u2212\u2012\u2013\u2014]/g, "-")
    .replace(/,/g, "");
}

function tokenize(input: string): Token[] | null {
  const tokens: Token[] = [];
  let index = 0;
  while (index < input.length) {
    const char = input[index];
    if (char === " " || char === "\t") {
      index += 1;
      continue;
    }
    if (char >= "0" && char <= "9") {
      let number = "";
      while (index < input.length && /[0-9.]/.test(input[index])) {
        number += input[index];
        index += 1;
      }
      const value = Number(number);
      if (!Number.isFinite(value)) return null;
      tokens.push({ type: "number", value });
      continue;
    }
    if (char === ".") {
      let number = "";
      while (index < input.length && /[0-9.]/.test(input[index])) {
        number += input[index];
        index += 1;
      }
      const value = Number(number);
      if (!Number.isFinite(value)) return null;
      tokens.push({ type: "number", value });
      continue;
    }
    if (/[a-z]/i.test(char)) {
      let ident = "";
      while (index < input.length && /[a-z]/i.test(input[index])) {
        ident += input[index];
        index += 1;
      }
      tokens.push({ type: "ident", value: ident.toLowerCase() });
      continue;
    }
    if ("+-*/^%".includes(char)) {
      tokens.push({ type: "op", value: char });
      index += 1;
      continue;
    }
    if (char === "(") {
      tokens.push({ type: "lparen" });
      index += 1;
      continue;
    }
    if (char === ")") {
      tokens.push({ type: "rparen" });
      index += 1;
      continue;
    }
    return null;
  }
  return tokens;
}

class Parser {
  private position = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): number | null {
    const value = this.parseAddition();
    if (value === null || this.position !== this.tokens.length) return null;
    return value;
  }

  private peek(): Token | undefined {
    return this.tokens[this.position];
  }

  private parseAddition(): number | null {
    let left = this.parseMultiplication();
    if (left === null) return null;
    while (true) {
      const token = this.peek();
      if (token?.type === "op" && (token.value === "+" || token.value === "-")) {
        this.position += 1;
        const right = this.parseMultiplication();
        if (right === null) return null;
        left = token.value === "+" ? left + right : left - right;
        continue;
      }
      break;
    }
    return left;
  }

  private parseMultiplication(): number | null {
    let left = this.parseUnary();
    if (left === null) return null;
    while (true) {
      const token = this.peek();
      if (token?.type === "op" && (token.value === "*" || token.value === "/")) {
        this.position += 1;
        const right = this.parseUnary();
        if (right === null) return null;
        left = token.value === "*" ? left * right : left / right;
        continue;
      }
      break;
    }
    return left;
  }

  private parseUnary(): number | null {
    const token = this.peek();
    if (token?.type === "op" && (token.value === "+" || token.value === "-")) {
      this.position += 1;
      const operand = this.parseUnary();
      if (operand === null) return null;
      return token.value === "-" ? -operand : operand;
    }
    return this.parsePower();
  }

  private parsePower(): number | null {
    const base = this.parsePostfix();
    if (base === null) return null;
    const token = this.peek();
    if (token?.type === "op" && token.value === "^") {
      this.position += 1;
      // Right-associative, and the exponent may itself be unary (2^-3).
      const exponent = this.parseUnary();
      if (exponent === null) return null;
      return Math.pow(base, exponent);
    }
    return base;
  }

  private parsePostfix(): number | null {
    let value = this.parsePrimary();
    if (value === null) return null;
    while (this.peek()?.type === "op" && (this.peek() as { value: string }).value === "%") {
      this.position += 1;
      value = value / 100;
    }
    return value;
  }

  private parsePrimary(): number | null {
    const token = this.peek();
    if (!token) return null;
    if (token.type === "number") {
      this.position += 1;
      return token.value;
    }
    if (token.type === "lparen") {
      this.position += 1;
      const value = this.parseAddition();
      if (value === null || this.peek()?.type !== "rparen") return null;
      this.position += 1;
      return value;
    }
    if (token.type === "ident") {
      if (token.value in CONSTANTS) {
        this.position += 1;
        return CONSTANTS[token.value];
      }
      const fn = FUNCTIONS[token.value];
      if (fn) {
        this.position += 1;
        if (this.peek()?.type !== "lparen") return null;
        this.position += 1;
        const argument = this.parseAddition();
        if (argument === null || this.peek()?.type !== "rparen") return null;
        this.position += 1;
        return fn(argument);
      }
    }
    return null;
  }
}

const EXPRESSION_SIGNAL = /[+\-*/^%()]|\b(?:sqrt|sin|cos|tan|abs|round|floor|ceil|pi|e)\b|[\u00d7\u00f7\u2212\u2013\u2014]/i;

/**
 * Evaluate an arithmetic expression. Returns null for bare numbers or inputs
 * that are not recognisable expressions (so callers don't treat "42" as math).
 */
export function evaluateExpression(text: string): MathResult | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const normalized = normalizeExpression(trimmed);
  // Require a real operator/function/paren so bare numbers are rejected.
  if (!EXPRESSION_SIGNAL.test(trimmed)) return null;
  const tokens = tokenize(normalized);
  if (!tokens || tokens.length === 0) return null;
  // A lone number token (after normalization) is not an expression.
  if (tokens.length === 1 && tokens[0].type === "number") return null;
  const value = new Parser(tokens).parse();
  if (value === null || !Number.isFinite(value)) return null;
  return { value, display: formatNumber(value) };
}

// ---------------------------------------------------------------------------
// Unit conversion
// ---------------------------------------------------------------------------

type UnitCategory = "length" | "mass" | "data" | "time" | "speed" | "area" | "volume";

// Linear units: value in base unit = amount * factor.
const LINEAR_UNITS: Record<string, { category: UnitCategory; factor: number }> = {
  // length (base: metre)
  m: { category: "length", factor: 1 },
  km: { category: "length", factor: 1000 },
  cm: { category: "length", factor: 0.01 },
  mm: { category: "length", factor: 0.001 },
  nm: { category: "length", factor: 1e-9 },
  mi: { category: "length", factor: 1609.344 },
  yd: { category: "length", factor: 0.9144 },
  ft: { category: "length", factor: 0.3048 },
  in: { category: "length", factor: 0.0254 },
  // mass (base: kilogram)
  kg: { category: "mass", factor: 1 },
  g: { category: "mass", factor: 0.001 },
  mg: { category: "mass", factor: 1e-6 },
  t: { category: "mass", factor: 1000 },
  lb: { category: "mass", factor: 0.45359237 },
  oz: { category: "mass", factor: 0.028349523125 },
  // data (base: byte)
  b: { category: "data", factor: 1 },
  kb: { category: "data", factor: 1024 },
  mb: { category: "data", factor: 1024 ** 2 },
  gb: { category: "data", factor: 1024 ** 3 },
  tb: { category: "data", factor: 1024 ** 4 },
  kib: { category: "data", factor: 1024 },
  mib: { category: "data", factor: 1024 ** 2 },
  gib: { category: "data", factor: 1024 ** 3 },
  tib: { category: "data", factor: 1024 ** 4 },
  // time (base: second)
  s: { category: "time", factor: 1 },
  sec: { category: "time", factor: 1 },
  min: { category: "time", factor: 60 },
  h: { category: "time", factor: 3600 },
  hr: { category: "time", factor: 3600 },
  day: { category: "time", factor: 86400 },
  week: { category: "time", factor: 604800 },
  // speed (base: metre/second)
  "m/s": { category: "speed", factor: 1 },
  "km/h": { category: "speed", factor: 1000 / 3600 },
  mph: { category: "speed", factor: 1609.344 / 3600 },
  knot: { category: "speed", factor: 1852 / 3600 },
  // area (base: square metre)
  m2: { category: "area", factor: 1 },
  km2: { category: "area", factor: 1e6 },
  ha: { category: "area", factor: 1e4 },
  acre: { category: "area", factor: 4046.8564224 },
  ft2: { category: "area", factor: 0.09290304 },
  // volume (base: litre)
  l: { category: "volume", factor: 1 },
  ml: { category: "volume", factor: 0.001 },
  m3: { category: "volume", factor: 1000 },
  gal: { category: "volume", factor: 3.785411784 },
  qt: { category: "volume", factor: 0.946352946 },
  cup: { category: "volume", factor: 0.2365882365 },
};

const UNIT_ALIASES: Record<string, string> = {
  "°c": "c",
  celsius: "c",
  "°f": "f",
  fahrenheit: "f",
  kelvin: "k",
};

const TEMPERATURE_UNITS = new Set(["c", "f", "k"]);

function canonicalUnit(raw: string): string {
  const lower = raw.trim().toLowerCase();
  return UNIT_ALIASES[lower] ?? lower;
}

function toCelsius(value: number, unit: string): number | null {
  if (unit === "c") return value;
  if (unit === "f") return (value - 32) * (5 / 9);
  if (unit === "k") return value - 273.15;
  return null;
}

function fromCelsius(value: number, unit: string): number | null {
  if (unit === "c") return value;
  if (unit === "f") return value * (9 / 5) + 32;
  if (unit === "k") return value + 273.15;
  return null;
}

const CONVERSION_PATTERN =
  /^\s*(-?\d+(?:\.\d+)?)\s*([a-zA-Z°/0-9/]+)\s*(?:to|->|→|in|=)?\s*([a-zA-Z°/0-9/]+)\s*$/;

export const CURRENCY_CODES = new Set([
  "usd",
  "cny",
  "eur",
  "jpy",
  "gbp",
  "hkd",
  "krw",
  "aud",
  "cad",
  "chf",
  "sgd",
  "nzd",
  "thb",
  "myr",
  "rub",
  "inr",
]);

export interface CurrencyPair {
  amount: number;
  from: string;
  to: string;
}

/** Detect a "100 usd cny" / "100 USD to CNY" currency conversion request. */
export function parseCurrencyPair(text: string): CurrencyPair | null {
  const match = CONVERSION_PATTERN.exec(text.replace(/,/g, ""));
  if (!match) return null;
  const amount = Number(match[1]);
  const from = match[2].toLowerCase();
  const to = match[3].toLowerCase();
  if (!Number.isFinite(amount)) return null;
  if (!CURRENCY_CODES.has(from) || !CURRENCY_CODES.has(to)) return null;
  return { amount, from: from.toUpperCase(), to: to.toUpperCase() };
}

/** Convert between currencies given rates expressed as units per USD. */
export function convertCurrency(
  amount: number,
  from: string,
  to: string,
  rates: Record<string, number>,
): number | null {
  const fromRate = from.toUpperCase() === "USD" ? 1 : rates[from.toUpperCase()];
  const toRate = to.toUpperCase() === "USD" ? 1 : rates[to.toUpperCase()];
  if (!Number.isFinite(fromRate) || !Number.isFinite(toRate) || !fromRate) return null;
  const usd = amount / fromRate;
  return usd * toRate;
}

/**
 * Convert between physical units (length/mass/temperature/data/time/speed/
 * area/volume). Returns null when the units are unknown or incompatible.
 */
export function convertUnits(text: string): ConversionResult | null {
  const match = CONVERSION_PATTERN.exec(text.replace(/,/g, ""));
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  const from = canonicalUnit(match[2]);
  const to = canonicalUnit(match[3]);
  if (from === to) return null;

  // Temperature uses affine formulas, not linear factors.
  if (TEMPERATURE_UNITS.has(from) || TEMPERATURE_UNITS.has(to)) {
    if (!TEMPERATURE_UNITS.has(from) || !TEMPERATURE_UNITS.has(to)) return null;
    const celsius = toCelsius(amount, from);
    if (celsius === null) return null;
    const converted = fromCelsius(celsius, to);
    if (converted === null) return null;
    return {
      value: converted,
      display: `${formatNumber(converted)} ${match[3].toLowerCase()}`,
      from,
      to,
    };
  }

  const fromUnit = LINEAR_UNITS[from];
  const toUnit = LINEAR_UNITS[to];
  if (!fromUnit || !toUnit || fromUnit.category !== toUnit.category) return null;
  const base = amount * fromUnit.factor;
  const converted = base / toUnit.factor;
  return {
    value: converted,
    display: `${formatNumber(converted)} ${to}`,
    from,
    to,
  };
}
