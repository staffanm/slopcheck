// Lark-compatible Earley parser in JavaScript

export class Token {
  constructor(type, value, start_pos = 0, end_pos = 0) {
    this.type = type;
    this.value = value;
    this.start_pos = start_pos;
    this.end_pos = end_pos;
  }
}

export class Tree {
  constructor(data, children = []) {
    this.data = data;
    this.children = children;
  }

  *iter_subtrees() {
    yield this;
    for (const child of this.children) {
      if (child instanceof Tree) yield* child.iter_subtrees();
    }
  }

  *iter_subtrees_topdown() {
    yield this;
    for (const child of this.children) {
      if (child instanceof Tree) yield* child.iter_subtrees_topdown();
    }
  }

  *scan_values(pred) {
    for (const child of this.children) {
      if (child instanceof Tree) yield* child.scan_values(pred);
      else if (pred(child)) yield child;
    }
  }

  pretty(indent = '') {
    let s = indent + this.data + '\n';
    for (const c of this.children) {
      if (c instanceof Tree) s += c.pretty(indent + '  ');
      else s += indent + '  ' + c.type + '\t' + c.value + '\n';
    }
    return s;
  }
}

export class UnexpectedInput extends Error {
  constructor(message, pos_in_stream) {
    super(message);
    this.name = 'UnexpectedInput';
    this.pos_in_stream = pos_in_stream;
  }
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class Lark {
  constructor(grammarText, options = {}) {
    this.options = options;
    this.terminals = new Map(); // name -> { name, regex, priority, filter }
    this.rules = [];            // array of { index, name, symbols, priority, expand1, isAnon }
    this.rulesByOrigin = new Map(); // name -> [rule]
    this.nullable = new Set();
    this.anonCount = 0;
    this._parseGrammar(grammarText);
    this._compileRules();
  }

  _parseGrammar(text) {
    const lines = text.split(/\r?\n/);
    const statements = [];
    let current = '';

    for (let line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#')) {
        continue;
      }
      if (/^\s+/.test(line) && current) {
        current += ' ' + trimmed;
      } else {
        if (current) statements.push(current);
        current = trimmed;
      }
    }
    if (current) statements.push(current);

    for (const stmt of statements) {
      this._parseStatement(stmt);
    }
  }

  _parseStatement(stmt) {
    let s = stmt;
    if (s.startsWith('%extend ')) {
      s = s.slice(8).trim();
    }

    const colonIdx = s.indexOf(':');
    if (colonIdx === -1) return;

    const head = s.slice(0, colonIdx).trim();
    const body = s.slice(colonIdx + 1).trim();

    const isTerminal = /^_?[A-Z][A-Z0-9_]*(\.\d+)?$/.test(head);

    if (isTerminal) {
      const [name, prioStr] = head.split('.');
      const priority = prioStr ? parseInt(prioStr, 10) : 0;
      this._parseTerminal(name, body, priority);
    } else {
      let rawHead = head;
      let expand1 = false;
      if (rawHead.startsWith('?')) {
        expand1 = true;
        rawHead = rawHead.slice(1).trim();
      }
      const [name, prioStr] = rawHead.split('.');
      const priority = prioStr ? parseInt(prioStr, 10) : 0;
      this._parseRuleDef(name, body, priority, expand1);
    }
  }

  _parseTerminal(name, body, priority) {
    const filter = name.startsWith('_');
    const alts = this._splitAlternations(body);
    const regexParts = [];
    let isCaseInsensitive = false;

    for (const alt of alts) {
      const trimmed = alt.trim();
      if (trimmed.startsWith('/') && trimmed.lastIndexOf('/') > 0) {
        const lastSlash = trimmed.lastIndexOf('/');
        let pat = trimmed.slice(1, lastSlash);
        const flags = trimmed.slice(lastSlash + 1);
        if (flags.includes('i')) isCaseInsensitive = true;
        pat = pat.replace(/\\w([åäö\u00e5\u00e4\u00f6])/g, '\\w$1\\u00c5\\u00c4\\u00d6');
        pat = pat.replace(/\[a-z\]\\b/g, '[a-z](?![a-zA-Z0-9_\\u00e5\\u00e4\\u00f6\\u00c5\\u00c4\\u00d6])');
        regexParts.push(pat);
      } else if (trimmed.startsWith('"') && (trimmed.endsWith('"') || trimmed.endsWith('"i'))) {
        const endQuote = trimmed.lastIndexOf('"');
        const str = trimmed.slice(1, endQuote);
        const flags = trimmed.slice(endQuote + 1);
        if (flags.includes('i')) isCaseInsensitive = true;
        regexParts.push(escapeRegex(str));
      } else {
        regexParts.push(trimmed);
      }
    }

    const fullPat = regexParts.length === 1 ? regexParts[0] : `(?:${regexParts.join('|')})`;
    const flags = (isCaseInsensitive ? 'i' : '') + 'y';
    const regex = new RegExp(fullPat, flags);

    this.terminals.set(name, {
      name,
      regex,
      priority,
      filter,
    });
  }

  _parseRuleDef(name, body, priority, expand1) {
    const rawAlts = this._splitAlternations(body);
    for (const alt of rawAlts) {
      const tokens = this._tokenizeRuleBody(alt);
      const expandedAlts = this._expandEbnf(tokens);
      for (const exp of expandedAlts) {
        this.rules.push({
          name,
          symbols: exp,
          priority,
          expand1,
          isAnon: false,
        });
      }
    }
  }

  _splitAlternations(str) {
    const alts = [];
    let start = 0;
    let parenDepth = 0;
    let inQuote = false;
    let inRegex = false;

    for (let i = 0; i < str.length; i++) {
      const c = str[i];
      if (c === '\\' && (inQuote || inRegex)) {
        i++;
        continue;
      }
      if (c === '"' && !inRegex) {
        inQuote = !inQuote;
      } else if (c === '/' && !inQuote) {
        inRegex = !inRegex;
      } else if (!inQuote && !inRegex) {
        if (c === '(') parenDepth++;
        else if (c === ')') parenDepth--;
        else if (c === '|' && parenDepth === 0) {
          alts.push(str.slice(start, i).trim());
          start = i + 1;
        }
      }
    }
    alts.push(str.slice(start).trim());
    return alts;
  }

  _tokenizeRuleBody(str) {
    const tokens = [];
    let i = 0;
    while (i < str.length) {
      while (i < str.length && /\s/.test(str[i])) i++;
      if (i >= str.length) break;

      const c = str[i];
      if (c === '(') {
        let depth = 1;
        let j = i + 1;
        let inQ = false;
        let inR = false;
        while (j < str.length && depth > 0) {
          if (str[j] === '\\') { j += 2; continue; }
          if (str[j] === '"') inQ = !inQ;
          else if (str[j] === '/') inR = !inR;
          else if (!inQ && !inR) {
            if (str[j] === '(') depth++;
            else if (str[j] === ')') depth--;
          }
          j++;
        }
        const inner = str.slice(i + 1, j - 1);
        i = j;
        let op = null;
        if (i < str.length && (str[i] === '?' || str[i] === '*' || str[i] === '+')) {
          op = str[i++];
        }
        tokens.push({ type: 'group', value: inner, op });
      } else if (c === '"') {
        let j = i + 1;
        while (j < str.length && str[j] !== '"') {
          if (str[j] === '\\') j += 2;
          else j++;
        }
        j++;
        if (j < str.length && str[j] === 'i') {
          j++;
        }
        const strVal = str.slice(i, j);
        i = j;
        let op = null;
        if (i < str.length && (str[i] === '?' || str[i] === '*' || str[i] === '+')) {
          op = str[i++];
        }
        tokens.push({ type: 'literal', value: strVal, op });
      } else if (c === '/') {
        let j = i + 1;
        while (j < str.length && str[j] !== '/') {
          if (str[j] === '\\') j += 2;
          else j++;
        }
        j++;
        const regVal = str.slice(i, j);
        i = j;
        let op = null;
        if (i < str.length && (str[i] === '?' || str[i] === '*' || str[i] === '+')) {
          op = str[i++];
        }
        tokens.push({ type: 'regex', value: regVal, op });
      } else {
        const m = /^([a-zA-Z_][a-zA-Z0-9_]*)([?*+]?)/.exec(str.slice(i));
        if (!m) {
          throw new Error(`Unexpected character in rule body at ${i}: ${str.slice(i)}`);
        }
        tokens.push({ type: 'name', value: m[1], op: m[2] || null });
        i += m[0].length;
      }
    }
    return tokens;
  }

  _expandEbnf(tokens) {
    const resultSymbols = [];

    for (const tok of tokens) {
      let baseSym;
      if (tok.type === 'name') {
        baseSym = tok.value;
      } else if (tok.type === 'literal' || tok.type === 'regex') {
        const anonTerm = `__ANON_TERM_${++this.anonCount}`;
        this._parseTerminal(anonTerm, tok.value, 0);
        baseSym = anonTerm;
      } else if (tok.type === 'group') {
        const groupName = `__group_${++this.anonCount}`;
        const groupAlts = this._splitAlternations(tok.value);
        for (const alt of groupAlts) {
          const subTokens = this._tokenizeRuleBody(alt);
          const subExpansions = this._expandEbnf(subTokens);
          for (const subExp of subExpansions) {
            this.rules.push({
              name: groupName,
              symbols: subExp,
              priority: 0,
              expand1: false,
              isAnon: true,
            });
          }
        }
        baseSym = groupName;
      }

      if (!tok.op) {
        resultSymbols.push(baseSym);
      } else if (tok.op === '?') {
        const optName = `__opt_${++this.anonCount}`;
        this.rules.push({ name: optName, symbols: [baseSym], priority: 0, expand1: false, isAnon: true });
        this.rules.push({ name: optName, symbols: [], priority: 0, expand1: false, isAnon: true });
        resultSymbols.push(optName);
      } else if (tok.op === '*') {
        const starName = `__star_${++this.anonCount}`;
        this.rules.push({ name: starName, symbols: [starName, baseSym], priority: 0, expand1: false, isAnon: true });
        this.rules.push({ name: starName, symbols: [], priority: 0, expand1: false, isAnon: true });
        resultSymbols.push(starName);
      } else if (tok.op === '+') {
        const plusName = `__plus_${++this.anonCount}`;
        this.rules.push({ name: plusName, symbols: [plusName, baseSym], priority: 0, expand1: false, isAnon: true });
        this.rules.push({ name: plusName, symbols: [baseSym], priority: 0, expand1: false, isAnon: true });
        resultSymbols.push(plusName);
      }
    }

    return [resultSymbols];
  }

  _compileRules() {
    this.rulesByOrigin.clear();
    for (let i = 0; i < this.rules.length; i++) {
      const r = this.rules[i];
      r.index = i;
      if (!this.rulesByOrigin.has(r.name)) {
        this.rulesByOrigin.set(r.name, []);
      }
      this.rulesByOrigin.get(r.name).push(r);
    }

    // Compute nullable non-terminals
    this.nullable.clear();
    let changed = true;
    while (changed) {
      changed = false;
      for (const r of this.rules) {
        if (!this.nullable.has(r.name)) {
          const allNullable = r.symbols.every(s => this.nullable.has(s));
          if (allNullable) {
            this.nullable.add(r.name);
            changed = true;
          }
        }
      }
    }
  }

  parse(text) {
    const startRules = this.rulesByOrigin.get('start');
    if (!startRules) throw new Error('No start rule found in grammar');

    const N = text.length;
    const chart = Array.from({ length: N + 1 }, () => []);
    const chartSets = Array.from({ length: N + 1 }, () => new Map());

    function addItem(col, item) {
      const key = `${item.rule.index},${item.dot},${item.origin}`;
      const existing = chartSets[col].get(key);
      if (existing) {
        if (item.priority > existing.priority) {
          existing.priority = item.priority;
          existing.children = item.children;
        }
        return false;
      }
      chartSets[col].set(key, item);
      chart[col].push(item);
      return true;
    }

    for (const r of startRules) {
      addItem(0, {
        rule: r,
        dot: 0,
        origin: 0,
        priority: r.priority || 0,
        children: [],
      });
    }

    let furthestPos = 0;

    for (let i = 0; i <= N; i++) {
      const col = chart[i];
      if (col.length > 0) furthestPos = i;

      for (let itemIdx = 0; itemIdx < col.length; itemIdx++) {
        const item = col[itemIdx];
        const { rule, dot, origin, priority, children } = item;

        if (dot === rule.symbols.length) {
          // COMPLETE
          const originCol = chart[origin];
          for (let oi = 0; oi < originCol.length; oi++) {
            const oItem = originCol[oi];
            if (oItem.dot < oItem.rule.symbols.length && oItem.rule.symbols[oItem.dot] === rule.name) {
              addItem(i, {
                rule: oItem.rule,
                dot: oItem.dot + 1,
                origin: oItem.origin,
                priority: oItem.priority + priority,
                children: [...oItem.children, { rule, origin, end: i, children }],
              });
            }
          }
        } else {
          const sym = rule.symbols[dot];
          const term = this.terminals.get(sym);

          if (term) {
            // SCAN
            term.regex.lastIndex = i;
            const match = term.regex.exec(text);
            if (match && match.index === i && match[0].length > 0) {
              const len = match[0].length;
              const nextCol = i + len;
              if (nextCol <= N) {
                const tok = new Token(term.name, match[0], i, nextCol);
                addItem(nextCol, {
                  rule,
                  dot: dot + 1,
                  origin,
                  priority: priority + (term.priority || 0),
                  children: term.filter ? children : [...children, tok],
                });
              }
            }
          } else {
            // PREDICT
            const nextRules = this.rulesByOrigin.get(sym);
            if (nextRules) {
              for (const nr of nextRules) {
                addItem(i, {
                  rule: nr,
                  dot: 0,
                  origin: i,
                  priority: nr.priority || 0,
                  children: [],
                });
              }
            }

            // Handle nullable symbol advance
            if (this.nullable.has(sym)) {
              addItem(i, {
                rule,
                dot: dot + 1,
                origin,
                priority,
                children,
              });
            }
          }
        }
      }
    }

    let bestStart = null;
    for (const item of chart[N]) {
      if (item.rule.name === 'start' && item.origin === 0 && item.dot === item.rule.symbols.length) {
        if (!bestStart || item.priority > bestStart.priority) {
          bestStart = item;
        }
      }
    }

    if (!bestStart) {
      throw new UnexpectedInput(`Unexpected input at position ${furthestPos}`, furthestPos);
    }

    return this._buildTree(bestStart);
  }

  _buildTree(item) {
    const rule = item.rule;
    const rawChildren = item.children;

    const children = [];
    for (const c of rawChildren) {
      if (c instanceof Token) {
        children.push(c);
      } else if (c && c.rule) {
        const subTree = this._buildTree(c);
        if (c.rule.isAnon) {
          if (subTree instanceof Tree) {
            children.push(...subTree.children);
          } else if (subTree instanceof Token) {
            children.push(subTree);
          }
        } else {
          children.push(subTree);
        }
      }
    }

    if (rule.expand1 && children.length === 1 && children[0] instanceof Tree) {
      return children[0];
    }
    return new Tree(rule.name, children);
  }
}
