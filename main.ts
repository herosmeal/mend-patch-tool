// mend: a patch tool that reads an AI-written edit in any of four formats (unified diff, SEARCH/REPLACE
// blocks, V4A, JSON edit objects) and applies it to a tree of text files, all of it or none of it.
// Node 22, standard library only; run as `node main.ts [--format=NAME] [--check] [--strict] [PATCH]`.
// The full contract is SPEC.md in the kit this entry was built from; the comments name its sections.
//
// Layout: sections 1-4 and 9-10 (command line, output, safe paths, detection, JSON, atomic write) come
// first, then the shared line machinery of section 5, then one reader per remaining format (6, 7, 8).
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set; the last lines hand over to
// runner.ts, which runs this same CLI once per check in a fresh directory.

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
  readonly moves: [string, string][] = [];
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

// ---------- section 3: a file as lines ----------

interface FileText {
  lines: string[];
  br: string; // the file's own line break, '\r\n' or '\n'
  fin: boolean; // whether the text ends with that break
}

function fileText(text: string): FileText {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, fin: false };
  const lines = text.split(br);
  const fin = text.endsWith(br);
  if (fin) lines.pop();
  return { lines, br, fin };
}

function renderFile(f: FileText): string {
  return f.lines.length === 0 ? '' : f.lines.join(f.br) + (f.fin ? f.br : '');
}

// ---------- section 5: matching lines at three tiers ----------

const trailWs = (s: string): string => s.replace(/[ \t]+$/, '');
const bothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0]!;

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trailWs(a) === trailWs(b);
  return bothWs(a) === bothWs(b);
}

interface Found {
  tier: number;
  positions: number[]; // every 0-based start where O occurs, in order
}

/** O against the file's lines: the first tier (0 only when strict) at which O occurs at least once. */
function findTier(fileLines: string[], o: string[], strict: boolean): Found | null {
  if (o.length === 0 || o.length > fileLines.length) return null;
  for (const tier of strict ? [0] : [0, 1, 2]) {
    const positions: number[] = [];
    for (let i = 0; i + o.length <= fileLines.length; i++) {
      let ok = true;
      for (let j = 0; j < o.length; j++) {
        if (!lineEq(fileLines[i + j]!, o[j]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** At tier 2 a written line that starts with O's first line's indent takes the file's first matched line's. */
function reindent(text: string, oFirst: string, fFirst: string, tier: number): string {
  if (tier !== 2) return text;
  if (text.trim() === '') return text;
  const p = leadWs(oFirst);
  const w = leadWs(text);
  const cut = text.startsWith(p) ? p.length : p.startsWith(w) ? w.length : 0;
  return leadWs(fFirst) + text.slice(cut);
}

/** One body line of a hunk or chunk: context, old, new, or a `\` note about the line before it. */
interface BodyLine {
  k: ' ' | '-' | '+' | '\\';
  t: string;
  rawBlank?: boolean; // the patch line it came from was empty or only whitespace
}

const oldTexts = (body: BodyLine[]): string[] => body.filter((b) => b.k === ' ' || b.k === '-').map((b) => b.t);

/**
 * The lines a matched hunk or chunk writes at `pos`: context lines come out as the file's own matched
 * lines, new lines as written (re-indented at tier 2).
 */
function writtenLines(body: BodyLine[], fileLines: string[], pos: number, tier: number): string[] {
  const oFirst = oldTexts(body)[0] ?? '';
  const out: string[] = [];
  let oi = 0;
  for (const b of body) {
    if (b.k === '-') oi += 1;
    else if (b.k === ' ') {
      out.push(fileLines[pos + oi]!);
      oi += 1;
    } else if (b.k === '+') out.push(reindent(b.t, oFirst, fileLines[pos]!, tier));
  }
  return out;
}

/** True when a `\` line follows the body's last context or new line, so the result loses its final break. */
function noFinalBreak(body: BodyLine[]): boolean {
  let last = -1;
  body.forEach((b, i) => {
    if (b.k === ' ' || b.k === '+') last = i;
  });
  return last >= 0 && body[last + 1]?.k === '\\';
}

// ---------- section 9: JSON edits ----------

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

// ---------- section 6: unified diffs ----------

interface Hunk {
  a: number; // the -A of the header: where the old text claims to sit
  body: BodyLine[];
}

interface Section {
  diffOld: string | null;
  diffNew: string | null;
  headOld: string | null;
  headNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

const headPath = (line: string): string => {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
};

function unifiedSections(lines: string[]): Section[] {
  const sections: Section[] = [];
  let sec: Section | null = null;
  let inHeader = false;
  const start = (): Section => {
    sec = { diffOld: null, diffNew: null, headOld: null, headNew: null, renameFrom: null, renameTo: null, newFile: false, delFile: false, hunks: [] };
    sections.push(sec);
    inHeader = true;
    return sec;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = start();
      s.diffOld = m[1]!;
      s.diffNew = m[2]!;
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const body: BodyLine[] = [];
      i += 1;
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '') body.push({ k: ' ', t: '' });
        else if (b[0] === ' ') body.push({ k: ' ', t: b.slice(1) });
        else if (b[0] === '-') body.push({ k: '-', t: b.slice(1) });
        else if (b[0] === '+') body.push({ k: '+', t: b.slice(1) });
        else if (b[0] === '\\') body.push({ k: '\\', t: b });
        else break;
        i += 1;
      }
      while (body.length > 0) {
        const lastB = body[body.length - 1]!;
        if (lastB.k === ' ' && lastB.t === '') body.pop();
        else break;
      }
      sec.hunks.push({ a: Number(m[1]), body });
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (sec === null || !inHeader || sec.headOld !== null) start();
      sec!.headOld = headPath(line);
      sec!.headNew = headPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    if (sec !== null && inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) sec.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) sec.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) sec.newFile = true;
      else if (line.startsWith('deleted file mode')) sec.delFile = true;
    }
    i += 1;
  }
  return sections;
}

/** Apply one section's hunks in order to a file's lines; d carries the running length change. */
function applyHunks(f: FileText, hunks: Hunk[], strict: boolean, path: string): FileText {
  const lines = [...f.lines];
  let fin = f.fin;
  let d = 0;
  for (const h of hunks) {
    const o = oldTexts(h.body);
    const nCount = h.body.filter((b) => b.k === ' ' || b.k === '+').length;
    if (o.length === 0) {
      const at = Math.min(h.a + d, lines.length);
      const seg = h.body.filter((b) => b.k === '+').map((b) => b.t);
      lines.splice(at, 0, ...seg);
      if (at + seg.length === lines.length && lines.length > 0) fin = !noFinalBreak(h.body);
      d += seg.length;
      continue;
    }
    const found = findTier(lines, o, strict);
    if (found === null) throw new Fail('no-match', path);
    const want = h.a - 1 + d;
    let pos = found.positions[0]!;
    for (const p of found.positions) {
      if (Math.abs(p - want) < Math.abs(pos - want)) pos = p;
    }
    const atEnd = pos + o.length === lines.length;
    const seg = writtenLines(h.body, lines, pos, found.tier);
    lines.splice(pos, o.length, ...seg);
    if (atEnd) fin = !noFinalBreak(h.body);
    d += nCount - o.length;
  }
  return { lines, br: f.br, fin };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return unifiedSections(lines).map((sec) => {
    const oldPath = sec.headOld ?? sec.renameFrom ?? sec.diffOld;
    const newPath = sec.headNew ?? sec.renameTo ?? sec.diffNew;
    const isCreate = sec.headOld === '/dev/null' || sec.newFile;
    const isDelete = sec.headNew === '/dev/null' || sec.delFile;
    return (tree: Tree) => {
      if (isCreate) {
        const target = newPath!;
        if (!safe(target)) throw new Fail('unsafe', target);
        if (tree.get(target) !== null) throw new Fail('exists', target);
        const texts: string[] = [];
        let noBreak = false;
        for (const h of sec.hunks) {
          for (const b of h.body) if (b.k === '+') texts.push(b.t);
          if (h.body.some((b) => b.k === '+')) noBreak = noFinalBreak(h.body);
        }
        tree.now.set(target, texts.length === 0 ? '' : texts.join('\n') + (noBreak ? '' : '\n'));
        return;
      }
      if (isDelete) {
        const target = oldPath!;
        if (!safe(target)) throw new Fail('unsafe', target);
        if (tree.get(target) === null) throw new Fail('missing', target);
        tree.now.set(target, null);
        return;
      }
      const from = oldPath!;
      const to = newPath!;
      if (!safe(from)) throw new Fail('unsafe', from);
      if (to !== from && !safe(to)) throw new Fail('unsafe', to);
      const before = tree.get(from);
      if (before === null) throw new Fail('missing', from);
      if (to !== from && tree.get(to) !== null) throw new Fail('exists', to);
      const done = applyHunks(fileText(before), sec.hunks, strict, from);
      if (to !== from) {
        tree.now.set(to, renderFile(done));
        tree.now.set(from, null);
        tree.moves.push([from, to]);
      } else {
        tree.now.set(from, renderFile(done));
      }
    };
  });
}

// ---------- section 7: SEARCH/REPLACE blocks ----------

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = prevEnd; j < searchLine; j++) {
      const l = lines[j]!;
      if (!blank(l) && !l.trim().startsWith('```')) path = l.trim();
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);
    let eq = -1;
    let rep = -1;
    for (let j = searchLine + 1; j < lines.length; j++) {
      if (eq < 0 && lines[j]!.trimEnd() === '=======') eq = j;
      else if (eq >= 0 && lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const f = fileText(before);
      const found = findTier(f.lines, oldLines, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.positions.length > 1) throw new Fail('ambiguous', p);
      const pos = found.positions[0]!;
      const seg = newLines.map((t) => reindent(t, oldLines[0]!, f.lines[pos]!, found.tier));
      f.lines.splice(pos, oldLines.length, ...seg);
      tree.now.set(p, renderFile(f));
    });
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

// ---------- section 8: V4A patches ----------

interface Chunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  line: number; // 1-based line of the section header
  addLines: string[];
  moveTo: string | null;
  chunks: Chunk[];
}

const v4aHead = (line: string): { kind: V4aSection['kind']; path: string } | null => {
  for (const [pre, kind] of [['*** Add File: ', 'add'], ['*** Delete File: ', 'delete'], ['*** Update File: ', 'update']] as const) {
    if (line.startsWith(pre)) return { kind, path: line.slice(pre.length).trim() };
  }
  return null;
};

function v4aSections(lines: string[]): V4aSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last <= first || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const head = v4aHead(line);
    if (head === null) throw new Exit2(`error: parse ${i + 1}`);
    const sec: V4aSection = { kind: head.kind, path: head.path, line: i + 1, addLines: [], moveTo: null, chunks: [] };
    sections.push(sec);
    i += 1;
    if (head.kind === 'add') {
      while (i < last && v4aHead(lines[i]!) === null) {
        const b = lines[i]!;
        if (b.startsWith('+')) sec.addLines.push(b.slice(1));
        else if (b === '') sec.addLines.push('');
        else throw new Exit2(`error: parse ${i + 1}`);
        i += 1;
      }
      while (sec.addLines.length > 0 && sec.addLines[sec.addLines.length - 1] === '') sec.addLines.pop();
    } else if (head.kind === 'delete') {
      while (i < last && v4aHead(lines[i]!) === null) {
        if (!blank(lines[i]!)) throw new Exit2(`error: parse ${i + 1}`);
        i += 1;
      }
    } else {
      let chunk: Chunk | null = null;
      let firstLine = true;
      while (i < last && v4aHead(lines[i]!) === null) {
        const b = lines[i]!;
        if (firstLine && b.startsWith('*** Move to: ')) {
          sec.moveTo = b.slice(13).trim();
          i += 1;
          firstLine = false;
          continue;
        }
        firstLine = false;
        if (b.startsWith('@@')) {
          const anchor = b.slice(2).trim();
          chunk = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
          sec.chunks.push(chunk);
        } else if (b.trim() === '*** End of File') {
          if (chunk === null) {
            chunk = { anchor: null, eof: true, body: [] };
            sec.chunks.push(chunk);
          } else chunk.eof = true;
          chunk = null;
        } else if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+') {
          if (chunk === null) {
            chunk = { anchor: null, eof: false, body: [] };
            sec.chunks.push(chunk);
          }
          chunk.body.push(b === '' ? { k: ' ', t: '', rawBlank: true } : { k: b[0] as BodyLine['k'], t: b.slice(1), rawBlank: b.trim() === '' });
        } else throw new Exit2(`error: parse ${i + 1}`);
        i += 1;
      }
      // Blank lines at the end of a section are not part of it: drop the last chunk's blank tail.
      const lastChunk = sec.chunks[sec.chunks.length - 1];
      if (lastChunk !== undefined) {
        while (lastChunk.body.length > 0 && lastChunk.body[lastChunk.body.length - 1]!.rawBlank === true) lastChunk.body.pop();
      }
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.line}`);
    }
  }
  return sections;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  return v4aSections(lines).map((sec) => {
    const p = sec.path;
    return (tree: Tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (sec.kind === 'add') {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n');
        return;
      }
      if (sec.kind === 'delete') {
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
        return;
      }
      const to = sec.moveTo;
      if (to !== null && !safe(to)) throw new Fail('unsafe', to);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      if (to !== null && tree.get(to) !== null) throw new Fail('exists', to);
      const f = fileText(before);
      const fileLines = [...f.lines];
      let cursor = 0;
      for (const chunk of sec.chunks) {
        if (chunk.anchor !== null) {
          let hit = -1;
          for (const tier of strict ? [0] : [0, 1, 2]) {
            for (let j = cursor; j < fileLines.length; j++) {
              if (lineEq(fileLines[j]!, chunk.anchor, tier)) {
                hit = j;
                break;
              }
            }
            if (hit >= 0) break;
          }
          if (hit < 0) throw new Fail('no-match', p);
          cursor = hit + 1;
        }
        const o = oldTexts(chunk.body);
        if (o.length === 0) {
          const seg = chunk.body.filter((b) => b.k === '+').map((b) => b.t);
          const at = chunk.eof ? fileLines.length : Math.min(cursor, fileLines.length);
          fileLines.splice(at, 0, ...seg);
          cursor = at + seg.length;
          continue;
        }
        let placed: { tier: number; pos: number } | null = null;
        for (const tier of strict ? [0] : [0, 1, 2]) {
          for (let x = cursor; x + o.length <= fileLines.length; x++) {
            if (chunk.eof && x + o.length !== fileLines.length) continue;
            if (o.every((t, j) => lineEq(fileLines[x + j]!, t, tier))) {
              placed = { tier, pos: x };
              break;
            }
          }
          if (placed !== null) break;
        }
        if (placed === null) throw new Fail('no-match', p);
        const seg = writtenLines(chunk.body, fileLines, placed.pos, placed.tier);
        fileLines.splice(placed.pos, o.length, ...seg);
        cursor = placed.pos + seg.length;
      }
      const out = renderFile({ lines: fileLines, br: f.br, fin: f.fin });
      if (to !== null) {
        tree.now.set(to, out);
        tree.now.set(p, null);
        tree.moves.push([p, to]);
      } else {
        tree.now.set(p, out);
      }
    };
  });
}

// ---------- sections 1, 2 and 10: run, report, write ----------

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
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = [...tree.now.keys()].filter((p) => tree.original(p) !== tree.now.get(p)!);
  const byBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const moveByNew = new Map<string, string>();
  for (const [from, to] of tree.moves) {
    if (tree.original(from) !== null && tree.now.get(from) === null && tree.original(to) === null && tree.now.get(to) !== null && tree.now.get(to) !== undefined) {
      moveByNew.set(to, from);
    }
  }
  const rows: { key: string; text: string }[] = [];
  for (const p of changed) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === null && moveByNew.has(p)) rows.push({ key: p, text: `R ${moveByNew.get(p)} -> ${p}` });
    else if (now === null && [...moveByNew.values()].includes(p)) continue;
    else rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byBytes(a.key, b.key));
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
