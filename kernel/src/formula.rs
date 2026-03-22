use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq)]
pub struct Program {
    pub bindings: Vec<Binding>,
    pub body: Expr,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Binding {
    pub name: String,
    pub value: Expr,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Expr {
    Number(f64),
    Variable(String),
    Argv(usize),
    Unary {
        op: UnaryOp,
        expr: Box<Expr>,
    },
    Binary {
        left: Box<Expr>,
        op: BinaryOp,
        right: Box<Expr>,
    },
    Call {
        name: String,
        args: Vec<Expr>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnaryOp {
    Plus,
    Negate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BinaryOp {
    Add,
    Subtract,
    Multiply,
    Divide,
    Power,
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum FormulaError {
    #[error("{0}")]
    Message(String),
}

pub fn parse(source: &str) -> Result<Program, FormulaError> {
    Parser::new(source).parse_program()
}

pub fn evaluate(source: &str, argv: &[String]) -> Result<String, FormulaError> {
    let program = parse(source)?;
    let value = eval_program(&program, argv)?;
    Ok(format_number(value))
}

fn eval_program(program: &Program, argv: &[String]) -> Result<f64, FormulaError> {
    let mut env = HashMap::new();
    for binding in &program.bindings {
        let value = eval_expr(&binding.value, argv, &env)?;
        env.insert(binding.name.clone(), value);
    }
    eval_expr(&program.body, argv, &env)
}

fn eval_expr(
    expr: &Expr,
    argv: &[String],
    env: &HashMap<String, f64>,
) -> Result<f64, FormulaError> {
    match expr {
        Expr::Number(value) => Ok(*value),
        Expr::Variable(name) => env
            .get(name)
            .copied()
            .or_else(|| match name.as_str() {
                "pi" => Some(std::f64::consts::PI),
                "e" => Some(std::f64::consts::E),
                _ => None,
            })
            .ok_or_else(|| FormulaError::Message(format!("unknown variable `{name}`"))),
        Expr::Argv(slot) => {
            let raw = argv
                .get(slot.saturating_sub(1))
                .ok_or_else(|| FormulaError::Message(format!("missing argument ${slot}")))?;
            raw.trim()
                .parse::<f64>()
                .map_err(|_| FormulaError::Message(format!("argument ${slot} is not a number")))
                .and_then(ensure_finite)
        }
        Expr::Unary { op, expr } => {
            let value = eval_expr(expr, argv, env)?;
            match op {
                UnaryOp::Plus => Ok(value),
                UnaryOp::Negate => ensure_finite(-value),
            }
        }
        Expr::Binary { left, op, right } => {
            let left = eval_expr(left, argv, env)?;
            let right = eval_expr(right, argv, env)?;
            let value = match op {
                BinaryOp::Add => left + right,
                BinaryOp::Subtract => left - right,
                BinaryOp::Multiply => left * right,
                BinaryOp::Divide => {
                    if right == 0.0 {
                        return Err(FormulaError::Message("division by zero".to_string()));
                    }
                    left / right
                }
                BinaryOp::Power => left.powf(right),
            };
            ensure_finite(value)
        }
        Expr::Call { name, args } => eval_call(name, args, argv, env),
    }
}

fn eval_call(
    name: &str,
    args: &[Expr],
    argv: &[String],
    env: &HashMap<String, f64>,
) -> Result<f64, FormulaError> {
    let values = args
        .iter()
        .map(|expr| eval_expr(expr, argv, env))
        .collect::<Result<Vec<_>, _>>()?;
    let value = match (name, values.as_slice()) {
        ("sqrt", [value]) => {
            if *value < 0.0 {
                return Err(FormulaError::Message("sqrt() domain error".to_string()));
            }
            value.sqrt()
        }
        ("nrt", [value, degree]) => {
            if *degree == 0.0 {
                return Err(FormulaError::Message(
                    "nrt() requires a non-zero degree".to_string(),
                ));
            }
            value.powf(1.0 / degree)
        }
        ("abs", [value]) => value.abs(),
        ("sin", [value]) => value.sin(),
        ("cos", [value]) => value.cos(),
        ("tan", [value]) => value.tan(),
        ("ln", [value]) => {
            if *value <= 0.0 {
                return Err(FormulaError::Message("ln() domain error".to_string()));
            }
            value.ln()
        }
        ("log", [value]) => {
            if *value <= 0.0 {
                return Err(FormulaError::Message("log() domain error".to_string()));
            }
            value.log10()
        }
        ("exp", [value]) => value.exp(),
        ("min", [left, right]) => left.min(*right),
        ("max", [left, right]) => left.max(*right),
        _ => {
            return Err(FormulaError::Message(format!(
                "unsupported call `{name}` with {} arguments",
                values.len()
            )))
        }
    };
    ensure_finite(value)
}

fn ensure_finite(value: f64) -> Result<f64, FormulaError> {
    if value.is_finite() {
        Ok(value)
    } else {
        Err(FormulaError::Message(
            "expression produced a non-finite value".to_string(),
        ))
    }
}

fn format_number(value: f64) -> String {
    if value == 0.0 {
        return "0".to_string();
    }
    if value.fract() == 0.0 {
        return format!("{value:.0}");
    }
    let mut out = format!("{value:.12}");
    while out.contains('.') && out.ends_with('0') {
        out.pop();
    }
    if out.ends_with('.') {
        out.pop();
    }
    out
}

#[derive(Debug, Clone, PartialEq)]
enum TokenKind {
    Number(f64),
    Ident(String),
    Argv(usize),
    Let,
    In,
    Plus,
    Minus,
    Star,
    Slash,
    Caret,
    LParen,
    RParen,
    Comma,
    Semi,
    Equal,
    Eof,
}

struct Parser<'a> {
    source: &'a str,
    cursor: usize,
    current: TokenKind,
}

impl<'a> Parser<'a> {
    fn new(source: &'a str) -> Self {
        let mut parser = Self {
            source,
            cursor: 0,
            current: TokenKind::Eof,
        };
        parser.bump().expect("initial token");
        parser
    }

    fn parse_program(&mut self) -> Result<Program, FormulaError> {
        let mut bindings = Vec::new();
        if self.current == TokenKind::Let {
            self.bump()?;
            loop {
                let name = match &self.current {
                    TokenKind::Ident(name) => name.clone(),
                    _ => return self.error("expected binding name after `let`"),
                };
                self.bump()?;
                self.expect(TokenKind::Equal, "expected `=` in let binding")?;
                let value = self.parse_expr()?;
                bindings.push(Binding { name, value });
                match self.current {
                    TokenKind::Semi => {
                        self.bump()?;
                    }
                    TokenKind::In => {
                        self.bump()?;
                        break;
                    }
                    _ => return self.error("expected `;` or `in` after let binding"),
                }
            }
        }
        let body = self.parse_expr()?;
        if self.current != TokenKind::Eof {
            return self.error("unexpected trailing input");
        }
        Ok(Program { bindings, body })
    }

    fn parse_expr(&mut self) -> Result<Expr, FormulaError> {
        self.parse_add_sub()
    }

    fn parse_add_sub(&mut self) -> Result<Expr, FormulaError> {
        let mut expr = self.parse_mul_div()?;
        loop {
            let op = match self.current {
                TokenKind::Plus => BinaryOp::Add,
                TokenKind::Minus => BinaryOp::Subtract,
                _ => break,
            };
            self.bump()?;
            let right = self.parse_mul_div()?;
            expr = Expr::Binary {
                left: Box::new(expr),
                op,
                right: Box::new(right),
            };
        }
        Ok(expr)
    }

    fn parse_mul_div(&mut self) -> Result<Expr, FormulaError> {
        let mut expr = self.parse_power()?;
        loop {
            let op = match self.current {
                TokenKind::Star => BinaryOp::Multiply,
                TokenKind::Slash => BinaryOp::Divide,
                _ => break,
            };
            self.bump()?;
            let right = self.parse_power()?;
            expr = Expr::Binary {
                left: Box::new(expr),
                op,
                right: Box::new(right),
            };
        }
        Ok(expr)
    }

    fn parse_power(&mut self) -> Result<Expr, FormulaError> {
        let expr = self.parse_unary()?;
        if self.current == TokenKind::Caret {
            self.bump()?;
            let right = self.parse_power()?;
            Ok(Expr::Binary {
                left: Box::new(expr),
                op: BinaryOp::Power,
                right: Box::new(right),
            })
        } else {
            Ok(expr)
        }
    }

    fn parse_unary(&mut self) -> Result<Expr, FormulaError> {
        match self.current {
            TokenKind::Plus => {
                self.bump()?;
                Ok(Expr::Unary {
                    op: UnaryOp::Plus,
                    expr: Box::new(self.parse_unary()?),
                })
            }
            TokenKind::Minus => {
                self.bump()?;
                Ok(Expr::Unary {
                    op: UnaryOp::Negate,
                    expr: Box::new(self.parse_unary()?),
                })
            }
            _ => self.parse_primary(),
        }
    }

    fn parse_primary(&mut self) -> Result<Expr, FormulaError> {
        match &self.current {
            TokenKind::Number(value) => {
                let expr = Expr::Number(*value);
                self.bump()?;
                Ok(expr)
            }
            TokenKind::Argv(slot) => {
                let expr = Expr::Argv(*slot);
                self.bump()?;
                Ok(expr)
            }
            TokenKind::Ident(name) => {
                let name = name.clone();
                self.bump()?;
                if self.current == TokenKind::LParen {
                    self.bump()?;
                    let mut args = Vec::new();
                    if self.current != TokenKind::RParen {
                        loop {
                            args.push(self.parse_expr()?);
                            if self.current == TokenKind::Comma {
                                self.bump()?;
                                continue;
                            }
                            break;
                        }
                    }
                    self.expect(TokenKind::RParen, "expected `)` to close call")?;
                    Ok(Expr::Call { name, args })
                } else {
                    Ok(Expr::Variable(name))
                }
            }
            TokenKind::LParen => {
                self.bump()?;
                let expr = self.parse_expr()?;
                self.expect(TokenKind::RParen, "expected `)`")?;
                Ok(expr)
            }
            TokenKind::Let => self.error("let expressions must appear at the start of the formula"),
            _ => self.error("expected an expression"),
        }
    }

    fn expect(&mut self, expected: TokenKind, message: &str) -> Result<(), FormulaError> {
        if self.current == expected {
            self.bump()?;
            Ok(())
        } else {
            self.error(message)
        }
    }

    fn bump(&mut self) -> Result<(), FormulaError> {
        self.skip_ws();
        if self.cursor >= self.source.len() {
            self.current = TokenKind::Eof;
            return Ok(());
        }
        let rest = &self.source[self.cursor..];
        let mut chars = rest.char_indices();
        let (_, ch) = chars.next().expect("char");
        self.current = match ch {
            '+' => {
                self.cursor += 1;
                TokenKind::Plus
            }
            '-' => {
                self.cursor += 1;
                TokenKind::Minus
            }
            '*' => {
                self.cursor += 1;
                TokenKind::Star
            }
            '/' => {
                self.cursor += 1;
                TokenKind::Slash
            }
            '^' => {
                self.cursor += 1;
                TokenKind::Caret
            }
            '(' => {
                self.cursor += 1;
                TokenKind::LParen
            }
            ')' => {
                self.cursor += 1;
                TokenKind::RParen
            }
            ',' => {
                self.cursor += 1;
                TokenKind::Comma
            }
            ';' => {
                self.cursor += 1;
                TokenKind::Semi
            }
            '=' => {
                self.cursor += 1;
                TokenKind::Equal
            }
            '$' => {
                self.cursor += 1;
                let digits = self.consume_while(|c| c.is_ascii_digit());
                if digits.is_empty() {
                    return self.error("expected digits after `$`");
                }
                let slot = digits
                    .parse::<usize>()
                    .map_err(|_| FormulaError::Message("invalid argv slot".to_string()))?;
                TokenKind::Argv(slot)
            }
            c if c.is_ascii_digit() || c == '.' => self.lex_number()?,
            c if c.is_ascii_alphabetic() || c == '_' => self.lex_ident(),
            _ => return self.error(&format!("unexpected character `{ch}`")),
        };
        Ok(())
    }

    fn lex_number(&mut self) -> Result<TokenKind, FormulaError> {
        let start = self.cursor;
        let mut saw_digit = false;
        let mut saw_dot = false;
        while let Some(ch) = self.peek_char() {
            if ch.is_ascii_digit() {
                saw_digit = true;
                self.cursor += ch.len_utf8();
            } else if ch == '.' && !saw_dot {
                saw_dot = true;
                self.cursor += 1;
            } else {
                break;
            }
        }
        if matches!(self.peek_char(), Some('e' | 'E')) {
            self.cursor += 1;
            if matches!(self.peek_char(), Some('+' | '-')) {
                self.cursor += 1;
            }
            let exp = self.consume_while(|c| c.is_ascii_digit());
            if exp.is_empty() {
                return self.error("invalid scientific notation");
            }
        }
        if !saw_digit {
            return self.error("invalid number literal");
        }
        let value = self.source[start..self.cursor]
            .parse::<f64>()
            .map_err(|_| FormulaError::Message("invalid number literal".to_string()))?;
        Ok(TokenKind::Number(value))
    }

    fn lex_ident(&mut self) -> TokenKind {
        let ident = self.consume_while(|c| c.is_ascii_alphanumeric() || c == '_');
        match ident.as_str() {
            "let" => TokenKind::Let,
            "in" => TokenKind::In,
            _ => TokenKind::Ident(ident),
        }
    }

    fn consume_while(&mut self, mut predicate: impl FnMut(char) -> bool) -> String {
        let start = self.cursor;
        while let Some(ch) = self.peek_char() {
            if predicate(ch) {
                self.cursor += ch.len_utf8();
            } else {
                break;
            }
        }
        self.source[start..self.cursor].to_string()
    }

    fn peek_char(&self) -> Option<char> {
        self.source[self.cursor..].chars().next()
    }

    fn skip_ws(&mut self) {
        while let Some(ch) = self.peek_char() {
            if ch.is_whitespace() {
                self.cursor += ch.len_utf8();
            } else {
                break;
            }
        }
    }

    fn error<T>(&self, message: &str) -> Result<T, FormulaError> {
        Err(FormulaError::Message(message.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_let_bindings() {
        let program = parse("let x = 2; y = x^3 in y + 1").expect("parse");
        assert_eq!(program.bindings.len(), 2);
    }

    #[test]
    fn evaluates_arithmetic_and_functions() {
        assert_eq!(evaluate("sqrt(16) + nrt(27, 3)", &[]).expect("eval"), "7");
        assert_eq!(evaluate("2^3^2", &[]).expect("eval"), "512");
        assert_eq!(evaluate("let x = 1.5 in x * 2", &[]).expect("eval"), "3");
    }

    #[test]
    fn evaluates_argv_inputs() {
        assert_eq!(
            evaluate("$1 + $2", &["4".to_string(), "5.5".to_string()]).expect("eval"),
            "9.5"
        );
    }

    #[test]
    fn reports_invalid_argv() {
        let error = evaluate("$2", &["1".to_string()]).expect_err("missing argv should fail");
        assert_eq!(
            error,
            FormulaError::Message("missing argument $2".to_string())
        );
    }
}
