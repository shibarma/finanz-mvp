export type ParseMoneyResult =
  | { ok: true; value: number }
  | { ok: false; error: string };

const ALLOWED_CHARS_REGEX = /^[0-9+\-*/().\s]+$/;

type Token =
  | { type: 'number'; value: number }
  | { type: 'op'; op: '+' | '-' | '*' | '/' | 'u-'; precedence: number; associativity: 'left' | 'right' }
  | { type: 'paren'; value: '(' | ')' };

export function parseMoneyExpression(input: string): ParseMoneyResult {
  if (!input || !input.trim()) {
    return { ok: false, error: 'Некорректное выражение.' };
  }

  let expr = input.trim().replace(/,/g, '.');

  if (!ALLOWED_CHARS_REGEX.test(expr)) {
    return { ok: false, error: 'Недопустимые символы в выражении.' };
  }

  try {
    const tokens = tokenize(expr);
    const rpn = toRpn(tokens);
    const value = evalRpn(rpn);

    if (!Number.isFinite(value)) {
      return { ok: false, error: 'Некорректное выражение.' };
    }

    const rounded = Math.round(value * 100) / 100;
    return { ok: true, value: rounded };
  } catch {
    return { ok: false, error: 'Некорректное выражение.' };
  }
}

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let lastToken: Token | null = null;

  while (i < expr.length) {
    const ch = expr[i];

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    if (/[0-9.]/.test(ch)) {
      let numStr = ch;
      i++;
      while (i < expr.length && /[0-9.]/.test(expr[i])) {
        numStr += expr[i++];
      }
      const value = Number(numStr);
      if (Number.isNaN(value)) {
        throw new Error('Invalid number');
      }
      tokens.push({ type: 'number', value });
      lastToken = tokens[tokens.length - 1];
      continue;
    }

    if (ch === '(' || ch === ')') {
      tokens.push({ type: 'paren', value: ch });
      lastToken = tokens[tokens.length - 1];
      i++;
      continue;
    }

    if (ch === '+' || ch === '-' || ch === '*' || ch === '/') {
      let op: '+' | '-' | '*' | '/' | 'u-' = ch as any;
      if (
        ch === '-' &&
        (lastToken == null ||
          (lastToken.type === 'op') ||
          (lastToken.type === 'paren' && lastToken.value === '('))
      ) {
        op = 'u-';
      }

      const precedence =
        op === '+' || op === '-' ? 1 :
        op === '*' || op === '/' ? 2 :
        3;

      const associativity: 'left' | 'right' = op === 'u-' ? 'right' : 'left';

      tokens.push({ type: 'op', op, precedence, associativity });
      lastToken = tokens[tokens.length - 1];
      i++;
      continue;
    }

    throw new Error('Invalid character');
  }

  return tokens;
}

function toRpn(tokens: Token[]): Token[] {
  const output: Token[] = [];
  const stack: Token[] = [];

  for (const token of tokens) {
    if (token.type === 'number') {
      output.push(token);
    } else if (token.type === 'op') {
      const o1 = token;
      while (stack.length > 0) {
        const o2 = stack[stack.length - 1];
        if (o2.type !== 'op') break;

        if (
          (o1.associativity === 'left' && o1.precedence <= o2.precedence) ||
          (o1.associativity === 'right' && o1.precedence < o2.precedence)
        ) {
          output.push(stack.pop() as Token);
        } else {
          break;
        }
      }
      stack.push(o1);
    } else if (token.type === 'paren' && token.value === '(') {
      stack.push(token);
    } else if (token.type === 'paren' && token.value === ')') {
      let foundLeftParen = false;
      while (stack.length > 0) {
        const top = stack.pop() as Token;
        if (top.type === 'paren' && top.value === '(') {
          foundLeftParen = true;
          break;
        }
        output.push(top);
      }
      if (!foundLeftParen) {
        throw new Error('Mismatched parentheses');
      }
    }
  }

  while (stack.length > 0) {
    const top = stack.pop() as Token;
    if (top.type === 'paren') {
      throw new Error('Mismatched parentheses');
    }
    output.push(top);
  }

  return output;
}

function evalRpn(tokens: Token[]): number {
  const stack: number[] = [];

  for (const token of tokens) {
    if (token.type === 'number') {
      stack.push(token.value);
    } else if (token.type === 'op') {
      if (token.op === 'u-') {
        if (stack.length < 1) throw new Error('Invalid expression');
        const v = stack.pop() as number;
        stack.push(-v);
      } else {
        if (stack.length < 2) throw new Error('Invalid expression');
        const b = stack.pop() as number;
        const a = stack.pop() as number;
        let res: number;
        switch (token.op) {
          case '+':
            res = a + b;
            break;
          case '-':
            res = a - b;
            break;
          case '*':
            res = a * b;
            break;
          case '/':
            res = a / b;
            break;
          default:
            throw new Error('Unknown operator');
        }
        stack.push(res);
      }
    }
  }

  if (stack.length !== 1) {
    throw new Error('Invalid expression');
  }

  return stack[0];
}

