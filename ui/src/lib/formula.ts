export type FormulaProgram = {
  bindings: FormulaBinding[];
  body: FormulaExpr;
};

export type FormulaBinding = {
  name: string;
  value: FormulaExpr;
};

export type FormulaExpr =
  | { type: "number"; value: number; raw: string }
  | { type: "variable"; name: string }
  | { type: "argv"; slot: number }
  | { type: "unary"; op: "+" | "-"; expr: FormulaExpr }
  | { type: "binary"; op: "+" | "-" | "*" | "/" | "^"; left: FormulaExpr; right: FormulaExpr }
  | { type: "call"; name: string; args: FormulaExpr[] };

export type FormulaAnalysis =
  | { ok: true; program: FormulaProgram; tex: string }
  | { ok: false; error: string };

export const FORMULA_SYNTAX_OVERVIEW = [
  "numbers: 1, 2.5, .75, 1e3",
  "operators: +, -, *, /, ^",
  "functions: sqrt(x), nrt(x, n), abs(x), sin(x), cos(x), tan(x), ln(x), log(x), exp(x), min(a, b), max(a, b)",
  "constants: pi, e",
  "argv inputs: $1, $2, $3, ...",
  "let bindings: let x = 2; y = x^3 in y + $1",
].join("\n");

export function analyzeFormula(source: string): FormulaAnalysis {
  try {
    const program = parseFormula(source);
    return { ok: true, program, tex: renderProgramToTex(program) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function parseFormula(source: string): FormulaProgram {
  return new Parser(source).parseProgram();
}

export function renderProgramToTex(program: FormulaProgram): string {
  const substitutions = new Map<string, FormulaExpr>();
  for (const binding of program.bindings) {
    substitutions.set(binding.name, substituteExpr(binding.value, substitutions));
  }
  return renderExprToTex(substituteExpr(program.body, substitutions), 0);
}

function substituteExpr(expr: FormulaExpr, substitutions: Map<string, FormulaExpr>): FormulaExpr {
  switch (expr.type) {
    case "number":
    case "argv":
      return expr;
    case "variable":
      return substitutions.get(expr.name) ?? expr;
    case "unary":
      return { ...expr, expr: substituteExpr(expr.expr, substitutions) };
    case "binary":
      return {
        ...expr,
        left: substituteExpr(expr.left, substitutions),
        right: substituteExpr(expr.right, substitutions),
      };
    case "call":
      return { ...expr, args: expr.args.map((arg) => substituteExpr(arg, substitutions)) };
  }
}

function renderExprToTex(expr: FormulaExpr, parentPrecedence: number): string {
  switch (expr.type) {
    case "number":
      return expr.raw;
    case "variable":
      return `\\mathrm{${escapeText(expr.name)}}`;
    case "argv":
      return `\\mathrm{\\$${expr.slot}}`;
    case "unary": {
      const value = `${expr.op}${renderExprToTex(expr.expr, 4)}`;
      return parentPrecedence > 4 ? `\\left(${value}\\right)` : value;
    }
    case "binary": {
      const precedence = binaryPrecedence(expr.op);
      const left = renderExprToTex(expr.left, precedence);
      const right = renderExprToTex(expr.right, expr.op === "^" ? precedence - 1 : precedence + (expr.op === "-" ? 1 : 0));
      const rendered =
        expr.op === "*"
          ? `${left} \\cdot ${right}`
          : expr.op === "/"
            ? `\\frac{${renderExprToTex(expr.left, 0)}}{${renderExprToTex(expr.right, 0)}}`
            : expr.op === "^"
              ? `${left}^{${right}}`
              : `${left} ${expr.op} ${right}`;
      return parentPrecedence > precedence ? `\\left(${rendered}\\right)` : rendered;
    }
    case "call": {
      if (expr.name === "sqrt" && expr.args.length === 1) {
        return `\\sqrt{${renderExprToTex(expr.args[0], 0)}}`;
      }
      if (expr.name === "nrt" && expr.args.length === 2) {
        return `\\sqrt[${renderExprToTex(expr.args[1], 0)}]{${renderExprToTex(expr.args[0], 0)}}`;
      }
      const args = expr.args.map((arg) => renderExprToTex(arg, 0)).join(", ");
      return `\\operatorname{${escapeText(expr.name)}}\\left(${args}\\right)`;
    }
  }
}

function binaryPrecedence(op: FormulaExpr[Extract<keyof FormulaExpr, never>] | string): number {
  switch (op) {
    case "+":
    case "-":
      return 1;
    case "*":
    case "/":
      return 2;
    case "^":
      return 3;
    default:
      return 0;
  }
}

function escapeText(value: string) {
  return value.replace(/([{}_#$%&])/g, "\\\\$1");
}

type Token =
  | { type: "number"; value: number; raw: string }
  | { type: "ident"; value: string }
  | { type: "argv"; value: number }
  | { type: "let" | "in" | "+" | "-" | "*" | "/" | "^" | "(" | ")" | "," | ";" | "=" | "eof" };

class Parser {
  private cursor = 0;
  private current: Token = { type: "eof" };

  constructor(private readonly source: string) {
    this.bump();
  }

  parseProgram(): FormulaProgram {
    const bindings: FormulaBinding[] = [];
    if (this.current.type === "let") {
      this.bump();
      while (true) {
        const name = this.expectIdent("expected binding name after `let`");
        this.expect("=", "expected `=` in let binding");
        bindings.push({ name, value: this.parseExpr() });
        if (this.peekType() === ";") {
          this.bump();
          continue;
        }
        this.expect("in", "expected `;` or `in` after let binding");
        break;
      }
    }
    const body = this.parseExpr();
    if (this.current.type !== "eof") {
      throw new Error("unexpected trailing input");
    }
    return { bindings, body };
  }

  private parseExpr(): FormulaExpr {
    return this.parseAddSub();
  }

  private parseAddSub(): FormulaExpr {
    let expr = this.parseMulDiv();
    while (this.current.type === "+" || this.current.type === "-") {
      const op = this.current.type;
      this.bump();
      expr = { type: "binary", op, left: expr, right: this.parseMulDiv() };
    }
    return expr;
  }

  private parseMulDiv(): FormulaExpr {
    let expr = this.parsePower();
    while (this.current.type === "*" || this.current.type === "/") {
      const op = this.current.type;
      this.bump();
      expr = { type: "binary", op, left: expr, right: this.parsePower() };
    }
    return expr;
  }

  private parsePower(): FormulaExpr {
    const expr = this.parseUnary();
    if (this.current.type === "^") {
      this.bump();
      return { type: "binary", op: "^", left: expr, right: this.parsePower() };
    }
    return expr;
  }

  private parseUnary(): FormulaExpr {
    if (this.current.type === "+" || this.current.type === "-") {
      const op = this.current.type;
      this.bump();
      return { type: "unary", op, expr: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): FormulaExpr {
    switch (this.current.type) {
      case "number": {
        const token = this.current;
        this.bump();
        return { type: "number", value: token.value, raw: token.raw };
      }
      case "argv": {
        const slot = this.current.value;
        this.bump();
        return { type: "argv", slot };
      }
      case "ident": {
        const name = this.current.value;
        this.bump();
        if (this.peekType() === "(") {
          this.bump();
          const args: FormulaExpr[] = [];
          if (this.peekType() !== ")") {
            while (true) {
              args.push(this.parseExpr());
              if (this.peekType() === ",") {
                this.bump();
                continue;
              }
              break;
            }
          }
          this.expect(")", "expected `)` to close call");
          return { type: "call", name, args };
        }
        return { type: "variable", name };
      }
      case "(": {
        this.bump();
        const expr = this.parseExpr();
        this.expect(")", "expected `)`");
        return expr;
      }
      case "let":
        throw new Error("let expressions must appear at the start of the formula");
      default:
        throw new Error("expected an expression");
    }
  }


  private peekType(): Token["type"] {
    return this.current.type;
  }

  private expect(expected: Token["type"], message: string) {
    if (this.current.type !== expected) {
      throw new Error(message);
    }
    this.bump();
  }

  private expectIdent(message: string) {
    if (this.current.type !== "ident") {
      throw new Error(message);
    }
    const value = this.current.value;
    this.bump();
    return value;
  }

  private bump() {
    this.skipWhitespace();
    if (this.cursor >= this.source.length) {
      this.current = { type: "eof" };
      return;
    }
    const char = this.source[this.cursor]!;
    switch (char) {
      case "+":
      case "-":
      case "*":
      case "/":
      case "^":
      case "(":
      case ")":
      case ",":
      case ";":
      case "=":
        this.cursor += 1;
        this.current = { type: char };
        return;
      case "$": {
        this.cursor += 1;
        const digits = this.consumeWhile((value) => /\d/.test(value));
        if (!digits) {
          throw new Error("expected digits after `$`");
        }
        this.current = { type: "argv", value: Number(digits) };
        return;
      }
      default:
        if (/\d|\./.test(char)) {
          this.current = this.lexNumber();
          return;
        }
        if (/[A-Za-z_]/.test(char)) {
          const ident = this.consumeWhile((value) => /[A-Za-z0-9_]/.test(value));
          this.current = ident === "let" || ident === "in" ? { type: ident } : { type: "ident", value: ident };
          return;
        }
        throw new Error(`unexpected character \`${char}\``);
    }
  }

  private lexNumber(): Token {
    const start = this.cursor;
    let sawDigit = false;
    let sawDot = false;
    while (this.cursor < this.source.length) {
      const char = this.source[this.cursor]!;
      if (/\d/.test(char)) {
        sawDigit = true;
        this.cursor += 1;
      } else if (char === "." && !sawDot) {
        sawDot = true;
        this.cursor += 1;
      } else {
        break;
      }
    }
    if (/[eE]/.test(this.source[this.cursor] ?? "")) {
      this.cursor += 1;
      if (/[+-]/.test(this.source[this.cursor] ?? "")) {
        this.cursor += 1;
      }
      const exp = this.consumeWhile((value) => /\d/.test(value));
      if (!exp) {
        throw new Error("invalid scientific notation");
      }
    }
    if (!sawDigit) {
      throw new Error("invalid number literal");
    }
    const raw = this.source.slice(start, this.cursor);
    return { type: "number", value: Number(raw), raw };
  }

  private consumeWhile(predicate: (value: string) => boolean) {
    const start = this.cursor;
    while (this.cursor < this.source.length && predicate(this.source[this.cursor]!)) {
      this.cursor += 1;
    }
    return this.source.slice(start, this.cursor);
  }

  private skipWhitespace() {
    while (this.cursor < this.source.length && /\s/.test(this.source[this.cursor]!)) {
      this.cursor += 1;
    }
  }
}
