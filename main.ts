// main.ts is mend, the CLI SPEC.md specifies (MIT). It implements all of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, the three matching tiers, unified diffs, SEARCH/REPLACE blocks, V4A
// patches, JSON edits and the all-or-nothing write. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** What the parsers share: the strict flag, and the record of moves that succeeded (for the `R` output lines). */
interface Ctx {
  strict: boolean;
  moves: [string, string][];
}

/** A file's text as its lines, its own line break, and whether it ends with that break (SPEC.md section 3). */
interface FileText {
  lines: string[];
  br: string;
  final: boolean;
}

function splitText(text: string): FileText {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let fin = false;
  if (text.endsWith(br)) {
    fin = true;
    parts.pop();
  }
  return { lines: parts, br, final: fin };
}

function joinText(lines: string[], br: string, fin: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (fin ? br : '');
}

// ----- Section 5: matching lines at three tiers -----

const trimEndST = (s: string): string => s.replace(/[ \t]+$/, '');
const trimST = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadST = (s: string): string => /^[ \t]*/.exec(s)![0]!;

function eqTier(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndST(a) === trimEndST(b);
  return trimST(a) === trimST(b);
}

/** Every position >= from at which O occurs in lines at this tier; occurrences may overlap. */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const res: number[] = [];
  for (let i = from; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (!eqTier(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) res.push(i);
  }
  return res;
}

/** The first tier at which O occurs at or after `from`, with its occurrences; null when it occurs at no tier. */
function findTier(lines: string[], o: string[], strict: boolean, from: number): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of N: a context line (index into O, written as the file's own line) or an added line (its own text). */
type NItem = { ctx: number } | { add: string };

/** Write out N at a match: context lines from the file, added lines re-indented at tier 2 (section 5). */
function buildLines(n: NItem[], fileLines: string[], pos: number, tier: number, o: string[]): string[] {
  const f = tier === 2 ? leadST(fileLines[pos]!) : '';
  const p = tier === 2 ? leadST(o[0]!) : '';
  return n.map((it) => {
    if ('ctx' in it) return fileLines[pos + it.ctx]!;
    const s = it.add;
    if (tier !== 2) return s;
    if (s === '' || trimST(s) === '') return s;
    if (p === '' || s.startsWith(p)) return f + s.slice(p.length);
    return s;
  });
}

/** Derive O and N (section 5) from body items of kinds ctx/del/add. */
function onFromItems(items: { kind: string; text: string }[]): { o: string[]; n: NItem[] } {
  const o: string[] = [];
  const n: NItem[] = [];
  for (const it of items) {
    if (it.kind === 'ctx') {
      n.push({ ctx: o.length });
      o.push(it.text);
    } else if (it.kind === 'del') {
      o.push(it.text);
    } else if (it.kind === 'add') {
      n.push({ add: it.text });
    }
  }
  return { o, n };
}

/** Whether a `\` line immediately follows the last context or `+` item (section 6's end-of-file rule). */
function bsAfterLastN(items: { kind: string; text: string }[]): boolean {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const k = items[i]!.kind;
    if (k === 'ctx' || k === 'add') return items[i + 1]?.kind === 'bs';
  }
  return false;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ----- Section 6: unified diffs -----

interface BodyItem {
  kind: 'ctx' | 'del' | 'add' | 'bs';
  text: string;
  emptyLine?: boolean;
}

interface Hunk {
  a: number;
  items: BodyItem[];
}

interface Section {
  diffOld?: string;
  diffNew?: string;
  hdrOld?: string;
  hdrNew?: string;
  renameFrom?: string;
  renameTo?: string;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

/** The path of a `--- `/`+++ ` line: after the four characters, up to a tab, spaces removed, a/ b/ prefix removed. */
function hdrPath(line: string): string {
  let rest = line.slice(4);
  const tab = rest.indexOf('\t');
  if (tab >= 0) rest = rest.slice(0, tab);
  rest = rest.trim();
  if (rest !== '/dev/null' && (rest.startsWith('a/') || rest.startsWith('b/'))) rest = rest.slice(2);
  return rest;
}

/** The paths of a `diff --git a/<X> b/<Y>` line, or null when it is not of that form. */
function diffPaths(line: string): [string, string] | null {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) return null;
  const sep = rest.indexOf(' b/', 2);
  if (sep < 0) return null;
  const x = rest.slice(2, sep);
  const y = rest.slice(sep + 3);
  if (x === '' || y === '') return null;
  return [x, y];
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function unifiedSections(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  const fresh = (): Section => ({ newFile: false, delFile: false, hunks: [] });
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const dp = diffPaths(line);
      if (dp === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh();
      cur.diffOld = dp[0];
      cur.diffNew = dp[1];
      sections.push(cur);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && cur.hunks.length === 0 && cur.hdrOld === undefined) {
        cur.hdrOld = hdrPath(line);
        cur.hdrNew = hdrPath(lines[i + 1]!);
      } else {
        cur = fresh();
        cur.hdrOld = hdrPath(line);
        cur.hdrNew = hdrPath(lines[i + 1]!);
        sections.push(cur);
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ') && cur !== null && cur.hunks.length === 0) {
      // A `--- ` line inside a section's header with no `+++ ` after it.
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (m === null || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const items: BodyItem[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '') {
          items.push({ kind: 'ctx', text: '', emptyLine: true });
          j += 1;
          continue;
        }
        const c = bl[0]!;
        if (c === ' ') items.push({ kind: 'ctx', text: bl.slice(1) });
        else if (c === '-') items.push({ kind: 'del', text: bl.slice(1) });
        else if (c === '+') items.push({ kind: 'add', text: bl.slice(1) });
        else if (c === '\\') items.push({ kind: 'bs', text: bl.slice(1) });
        else break;
        j += 1;
      }
      while (items.length > 0 && items[items.length - 1]!.emptyLine === true) items.pop();
      cur.hunks.push({ a: Number(m[1]), items });
      i = j;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
      // Anything else in a header is ignored.
    }
    // Lines outside sections and bodies are ignored.
    i += 1;
  }
  return sections;
}

/** Apply one hunk to a file's lines; returns the new lines, final-break flag and the length delta. */
function applyHunk(lines: string[], fin: boolean, hunk: Hunk, d: number, strict: boolean, path: string): { lines: string[]; fin: boolean; delta: number } {
  const { o, n } = onFromItems(hunk.items);
  if (o.length === 0) {
    const pos = Math.min(Math.max(hunk.a + d, 0), lines.length);
    const add = n.map((it) => ('add' in it ? it.add : ''));
    const out = [...lines.slice(0, pos), ...add, ...lines.slice(pos)];
    return { lines: out, fin: pos === lines.length ? !bsAfterLastN(hunk.items) : fin, delta: n.length };
  }
  const found = findTier(lines, o, strict, 0);
  if (found === null) throw new Fail('no-match', path);
  const target = hunk.a - 1 + d;
  let pos = found.occ[0]!;
  for (const p of found.occ) {
    if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
  }
  const built = buildLines(n, lines, pos, found.tier, o);
  const out = [...lines.slice(0, pos), ...built, ...lines.slice(pos + o.length)];
  const nf = pos + o.length === lines.length ? !bsAfterLastN(hunk.items) : fin;
  return { lines: out, fin: nf, delta: n.length - o.length };
}

function unifiedEdit(sec: Section, ctx: Ctx): Edit {
  return (tree) => {
    const oldP = sec.hdrOld !== undefined ? sec.hdrOld : sec.renameFrom !== undefined ? sec.renameFrom : sec.diffOld;
    const newP = sec.hdrNew !== undefined ? sec.hdrNew : sec.renameTo !== undefined ? sec.renameTo : sec.diffNew;
    if (sec.newFile || oldP === '/dev/null') {
      const p = newP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const items = sec.hunks.flatMap((h) => h.items);
      const content: string[] = [];
      let lastAdd = -1;
      items.forEach((it, ix) => {
        if (it.kind === 'add') {
          content.push(it.text);
          lastAdd = ix;
        }
      });
      const fin = !(lastAdd >= 0 && items[lastAdd + 1]?.kind === 'bs');
      tree.now.set(p, joinText(content, '\n', fin));
      return;
    }
    if (sec.delFile || newP === '/dev/null') {
      const p = oldP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const o = oldP!;
    const nw = newP!;
    if (!safe(o)) throw new Fail('unsafe', o);
    const isMove = nw !== o;
    if (isMove && !safe(nw)) throw new Fail('unsafe', nw);
    const before = tree.get(o);
    if (before === null) throw new Fail('missing', o);
    if (isMove && tree.get(nw) !== null) throw new Fail('exists', nw);
    const ft = splitText(before);
    let curLines = ft.lines;
    let curFin = ft.final;
    let d = 0;
    for (const h of sec.hunks) {
      const r = applyHunk(curLines, curFin, h, d, ctx.strict, o);
      curLines = r.lines;
      curFin = r.fin;
      d += r.delta;
    }
    tree.now.set(nw, joinText(curLines, ft.br, curFin));
    if (isMove) {
      tree.now.set(o, null);
      ctx.moves.push([o, nw]);
    }
  };
}

function unifiedEdits(lines: string[], ctx: Ctx): Edit[] {
  return unifiedSections(lines).map((s) => unifiedEdit(s, ctx));
}

// ----- Section 7: SEARCH/REPLACE blocks -----

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function srBlocks(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j >= prevEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${searchIdx + 1}`);
    }
    let k = searchIdx + 1;
    while (k < lines.length && lines[k]!.trimEnd() !== '=======') {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') throw new Exit2(`error: parse ${searchIdx + 1}`);
      k += 1;
    }
    if (k >= lines.length) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let m = k + 1;
    while (m < lines.length && lines[m]!.trimEnd() !== '>>>>>>> REPLACE') m += 1;
    if (m >= lines.length) throw new Exit2(`error: parse ${searchIdx + 1}`);
    blocks.push({ path, oldLines: lines.slice(searchIdx + 1, k), newLines: lines.slice(k + 1, m) });
    prevPath = path;
    prevEnd = m + 1;
    i = m + 1;
  }
  return blocks;
}

function srEdits(lines: string[], ctx: Ctx): Edit[] {
  return srBlocks(lines).map((b) => (tree: Tree) => {
    const p = b.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (b.oldLines.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, joinText(b.newLines, '\n', true));
      return;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const ft = splitText(before);
    const found = findTier(ft.lines, b.oldLines, ctx.strict, 0);
    if (found === null) throw new Fail('no-match', p);
    if (found.occ.length > 1) throw new Fail('ambiguous', p);
    const pos = found.occ[0]!;
    const built = buildLines(
      b.newLines.map((s) => ({ add: s })),
      ft.lines,
      pos,
      found.tier,
      b.oldLines,
    );
    const out = [...ft.lines.slice(0, pos), ...built, ...ft.lines.slice(pos + b.oldLines.length)];
    tree.now.set(p, joinText(out, ft.br, ft.final));
  });
}

// ----- Section 8: V4A patches -----

interface VChunk {
  anchor: string | null;
  eof: boolean;
  items: BodyItem[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  line: number;
  content: string[];
  moveTo: string | null;
  chunks: VChunk[];
}

function v4aSections(lines: string[]): VSection[] {
  const firstNB = lines.findIndex((l) => !blank(l));
  if (firstNB < 0) throw new Exit2('error: parse 1');
  if (lines[firstNB]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${firstNB + 1}`);
  let lastNB = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!blank(lines[i]!)) {
      lastNB = i;
      break;
    }
  }
  if (lines[lastNB]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  interface Raw {
    kind: VSection['kind'];
    path: string;
    line: number;
    raw: { text: string; line: number }[];
  }
  const raws: Raw[] = [];
  let cur: Raw | null = null;
  const starts: [string, VSection['kind']][] = [
    ['*** Add File: ', 'add'],
    ['*** Delete File: ', 'delete'],
    ['*** Update File: ', 'update'],
  ];
  for (let i = firstNB + 1; i < lastNB; i += 1) {
    const line = lines[i]!;
    let started = false;
    for (const [prefix, kind] of starts) {
      if (line.startsWith(prefix)) {
        cur = { kind, path: line.slice(prefix.length).trim(), line: i + 1, raw: [] };
        raws.push(cur);
        started = true;
        break;
      }
    }
    if (started) continue;
    if (cur === null) {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${i + 1}`);
    }
    cur.raw.push({ text: line, line: i + 1 });
  }

  return raws.map((r) => {
    const raw = [...r.raw];
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (r.kind === 'add') {
      const content: string[] = [];
      for (const { text, line } of raw) {
        if (text.startsWith('+')) content.push(text.slice(1));
        else if (text === '') content.push('');
        else throw new Exit2(`error: parse ${line}`);
      }
      return { kind: r.kind, path: r.path, line: r.line, content, moveTo: null, chunks: [] };
    }
    if (r.kind === 'delete') {
      for (const { text, line } of raw) {
        if (!blank(text)) throw new Exit2(`error: parse ${line}`);
      }
      return { kind: r.kind, path: r.path, line: r.line, content: [], moveTo: null, chunks: [] };
    }
    // Update File.
    let moveTo: string | null = null;
    let idx = 0;
    if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
      moveTo = raw[0]!.text.slice('*** Move to: '.length).trim();
      idx = 1;
    }
    const chunks: VChunk[] = [];
    let chunk: VChunk | null = null;
    let closedByEof = false;
    for (; idx < raw.length; idx += 1) {
      const { text, line } = raw[idx]!;
      if (text.startsWith('@@')) {
        const anchor = text.slice(2).trim();
        chunk = { anchor: anchor === '' ? null : anchor, eof: false, items: [] };
        chunks.push(chunk);
        closedByEof = false;
        continue;
      }
      if (text.trim() === '*** End of File') {
        if (chunk === null) throw new Exit2(`error: parse ${line}`);
        chunk.eof = true;
        chunk = null;
        closedByEof = true;
        continue;
      }
      const isBody = text === '' || text[0] === ' ' || text[0] === '-' || text[0] === '+';
      if (!isBody) throw new Exit2(`error: parse ${line}`);
      if (chunk === null) {
        if (chunks.length > 0 || closedByEof) throw new Exit2(`error: parse ${line}`);
        chunk = { anchor: null, eof: false, items: [] };
        chunks.push(chunk);
      }
      if (text === '') chunk.items.push({ kind: 'ctx', text: '' });
      else if (text[0] === ' ') chunk.items.push({ kind: 'ctx', text: text.slice(1) });
      else if (text[0] === '-') chunk.items.push({ kind: 'del', text: text.slice(1) });
      else chunk.items.push({ kind: 'add', text: text.slice(1) });
    }
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${r.line}`);
    return { kind: r.kind, path: r.path, line: r.line, content: [], moveTo, chunks };
  });
}

function v4aEdit(sec: VSection, ctx: Ctx): Edit {
  return (tree) => {
    const p = sec.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (sec.kind === 'add') {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, joinText(sec.content, '\n', true));
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    // Update File.
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const ft = splitText(before);
    const lines = [...ft.lines];
    let cursor = 0;
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null) {
        let at = -1;
        const tiers = ctx.strict ? [0] : [0, 1, 2];
        for (const t of tiers) {
          for (let i = cursor; i < lines.length; i += 1) {
            if (eqTier(lines[i]!, chunk.anchor, t)) {
              at = i;
              break;
            }
          }
          if (at >= 0) break;
        }
        if (at < 0) throw new Fail('no-match', p);
        cursor = at + 1;
      }
      const { o, n } = onFromItems(chunk.items);
      if (o.length === 0) {
        const pos = chunk.eof ? lines.length : Math.min(cursor, lines.length);
        const add = n.map((it) => ('add' in it ? it.add : ''));
        lines.splice(pos, 0, ...add);
        cursor = pos + add.length;
        continue;
      }
      const found = findTier(lines, o, ctx.strict, cursor);
      let pos = -1;
      let tier = 0;
      if (found !== null) {
        tier = found.tier;
        if (chunk.eof) {
          const want = lines.length - o.length;
          if (found.occ.includes(want) && want >= cursor) pos = want;
        } else {
          pos = found.occ[0]!;
        }
      }
      if (pos < 0) throw new Fail('no-match', p);
      const built = buildLines(n, lines, pos, tier, o);
      lines.splice(pos, o.length, ...built);
      cursor = pos + built.length;
    }
    const text = joinText(lines, ft.br, ft.final);
    if (sec.moveTo !== null) {
      tree.now.set(sec.moveTo, text);
      tree.now.set(p, null);
      ctx.moves.push([p, sec.moveTo]);
    } else {
      tree.now.set(p, text);
    }
  };
}

function v4aEdits(lines: string[], ctx: Ctx): Edit[] {
  return v4aSections(lines).map((s) => v4aEdit(s, ctx));
}

// ----- Section 9: JSON edits -----

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ----- Sections 1, 2 and 10: the command line, output, and the all-or-nothing write -----

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const ctx: Ctx = { strict, moves: [] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, ctx);
    else if (kind === 'search-replace') edits = srEdits(lines, ctx);
    else edits = v4aEdits(lines, ctx);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // A move that succeeded is reported as one `R` line replacing its pair's `D` and `A` lines (section 2).
  const movedTo = new Map<string, string>();
  const movedFrom = new Set<string>();
  for (const [o, nw] of ctx.moves) {
    const wasO = tree.original(o);
    const nowO = tree.now.has(o) ? tree.now.get(o)! : wasO;
    const wasN = tree.original(nw);
    const nowN = tree.now.has(nw) ? tree.now.get(nw)! : wasN;
    if (wasO !== null && nowO === null && wasN === null && nowN !== null && !movedTo.has(nw)) {
      movedTo.set(nw, o);
      movedFrom.add(o);
    }
  }
  const rows: string[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (movedTo.has(p)) rows.push(`R ${movedTo.get(p)} -> ${p}`);
    else if (!movedFrom.has(p)) rows.push(`${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
