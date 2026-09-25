const GLOB_REGEX_CACHE = new Map<string, RegExp>();

const BINARY_SAMPLE_BYTES = 8000;
const INVALID_UTF8_RATIO = 0.1;

/**
 * Default paths whose content is left out of the prompt. The file still appears
 * in the changed-file list, so the model can describe it without paying tokens
 * for bytes it cannot use. Users can override this with
 * `gitCommitPlanner.ignoredGlobs`, and setting it to `[]` disables the filter.
 */
export const DEFAULT_IGNORED_GLOBS: string[] = [
  '**/*.{png,jpg,jpeg,jfif,gif,webp,bmp,ico,tif,tiff,avif,heic,heif,svg}',
  '**/*.{fbx,glb,gltf,blend,blend1,3ds,max,dae,abc,stl,ply,obj,usd,usda,usdc,usdz}',
  '**/*.{mp4,mov,avi,mkv,webm,m4v,mp3,wav,ogg,oga,flac,m4a,aac,wma}',
  '**/*.{zip,gz,tgz,tar,rar,7z,bz2,xz,br}',
  '**/*.{woff,woff2,ttf,otf,eot}',
  '**/*.{pdf,psd,psb,ai,eps,sketch,xd,fig}',
  '**/*.{exe,dll,so,dylib,bin,wasm,class,jar,node,o,a,lib,pdb}',
  '**/*.lock',
  '**/package-lock.json',
  '**/npm-shrinkwrap.json',
  '**/pnpm-lock.yaml',
  '**/bun.lockb',
  '**/*.min.js',
  '**/*.min.css',
  '**/*.map'
];

/** Files above this size are never read into memory for the prompt. */
export const MAX_UNTRACKED_FILE_BYTES = 1_048_576;

/**
 * Returns true when a repository-relative path matches any configured glob.
 * Patterns without a slash match at any depth, like `.gitignore` entries.
 */
export function matchesAnyGlob(relativePath: string, globs: readonly string[]): boolean {
  if (!Array.isArray(globs) || globs.length === 0) {
    return false;
  }

  const normalized = relativePath.replace(/\\/g, '/');

  return globs.some(glob => {
    if (typeof glob !== 'string' || !glob.trim()) {
      return false;
    }

    return toRegExp(glob).test(normalized);
  });
}

/**
 * Splits a unified diff into per-file patches. Handles normal `diff --git`
 * patches and combined merge-conflict patches (`diff --cc` / `diff --combined`).
 * Returns `[diff]` when no boundary is found so callers never lose content.
 */
export function splitFilePatches(diff: string): string[] {
  const patches = diff.split(/(?=^diff (?:--git|--cc|--combined) )/m).filter(part => part.trim());
  return patches.length > 0 ? patches : [diff];
}

/**
 * Replaces the body of every patch whose path matches an ignored glob with a
 * short placeholder. The patch header stays so the model can still see that the
 * file changed. A patch that still contains more than one file header is never
 * replaced, so multiple files can never collapse into one placeholder.
 */
export function filterIgnoredPatches(diff: string, globs: readonly string[]): string {
  if (!diff || !Array.isArray(globs) || globs.length === 0) {
    return diff;
  }

  let filtered = false;
  // `splitFilePatches` uses a zero-width lookahead, so joining with an empty
  // string reproduces the original diff byte-for-byte outside replaced patches.
  const patches = splitFilePatches(diff).map(patch => {
    const filePath = extractPatchPath(patch);

    if (!filePath || !matchesAnyGlob(filePath, globs) || countFileHeaders(patch) > 1) {
      return patch;
    }

    filtered = true;
    const header = patch.split('\n', 1)[0] ?? `diff --git a/${filePath} b/${filePath}`;
    const trailingNewline = patch.endsWith('\n') ? '\n' : '';
    return `${header}\n[File content omitted because the path matches gitCommitPlanner.ignoredGlobs.]${trailingNewline}`;
  });

  return filtered ? patches.join('') : diff;
}

/**
 * Extracts the repository-relative path from a single patch. The `+++` and `---`
 * lines take precedence over the `diff --git` header because they are
 * unambiguous and cover deletions and renames.
 */
export function extractPatchPath(patch: string): string | undefined {
  let plus: string | undefined;
  let minus: string | undefined;
  let header: string | undefined;

  for (const rawLine of patch.split('\n')) {
    if (rawLine.startsWith('+++ ')) {
      plus ??= parseDiffPathLine(rawLine.slice(4));
    } else if (rawLine.startsWith('--- ')) {
      minus ??= parseDiffPathLine(rawLine.slice(4));
    } else if (rawLine.startsWith('diff --git ') && !header) {
      header = parseDiffGitHeaderPath(rawLine.slice('diff --git '.length));
    }
  }

  return plus ?? minus ?? header;
}

function countFileHeaders(patch: string): number {
  return patch.match(/^diff (?:--git|--cc|--combined) /gm)?.length ?? 0;
}

/**
 * Detects binary content using Git's own heuristic (a NUL byte in the sample),
 * plus a UTF-8 validity check that catches binary data without early NUL bytes.
 */
export function looksBinary(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, BINARY_SAMPLE_BYTES));

  if (sample.includes(0)) {
    return true;
  }

  if (sample.length === 0) {
    return false;
  }

  let replacementChars = 0;
  let characters = 0;

  for (const character of new TextDecoder('utf-8').decode(sample)) {
    characters += 1;
    if (character === '\uFFFD') {
      replacementChars += 1;
    }
  }

  return characters >= 16 && replacementChars / characters > INVALID_UTF8_RATIO;
}

/** Formats a byte count for placeholder messages. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${Math.round(bytes / (1024 * 1024))} MB`;
  }

  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }

  return `${bytes} bytes`;
}

function parseDiffPathLine(value: string): string | undefined {
  let text = value.split('\t')[0].trim();

  if (text.startsWith('"') && text.endsWith('"')) {
    try {
      text = JSON.parse(text);
    } catch {
      text = text.slice(1, -1);
    }
  }

  if (!text || text === '/dev/null') {
    return undefined;
  }

  return text.replace(/^[ab]\//, '');
}

function parseDiffGitHeaderPath(value: string): string | undefined {
  const header = value.trim();
  const quoted = header.match(/^(".*?")\s+(".*?")$/);

  if (quoted) {
    const decoded = tryJsonParse(quoted[2]);

    if (typeof decoded === 'string') {
      return decoded.replace(/^[ab]\//, '') || undefined;
    }
  }

  const separator = header.indexOf(' b/');

  if (separator < 0) {
    return undefined;
  }

  return header.slice(separator + 3) || undefined;
}

function tryJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** Matches nothing. Used for malformed user globs so they cannot abort a run. */
const NEVER_MATCH = /(?!)/;

function toRegExp(glob: string): RegExp {
  const cached = GLOB_REGEX_CACHE.get(glob);

  if (cached) {
    return cached;
  }

  let regexp: RegExp;

  try {
    regexp = new RegExp(`^${globToRegexSource(normalizeGlob(glob))}$`, 'i');
  } catch {
    regexp = NEVER_MATCH;
  }

  GLOB_REGEX_CACHE.set(glob, regexp);
  return regexp;
}

function normalizeGlob(glob: string): string {
  let pattern = glob.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');

  if (pattern.endsWith('/')) {
    return `${pattern.replace(/\/+$/, '')}/**`;
  }

  if (!pattern.includes('/')) {
    pattern = `**/${pattern}`;
  }

  return pattern;
}

function globToRegexSource(glob: string): string {
  let result = '';

  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];

    if (character === '*') {
      if (glob[index + 1] === '*') {
        while (glob[index + 1] === '*') {
          index += 1;
        }

        if (glob[index + 1] === '/') {
          index += 1;
          result += '(?:.*/)?';
        } else {
          result += '.*';
        }
      } else {
        result += '[^/]*';
      }

      continue;
    }

    if (character === '?') {
      result += '[^/]';
      continue;
    }

    if (character === '{') {
      const end = glob.indexOf('}', index);

      if (end > index) {
        const options = glob.slice(index + 1, end).split(',');
        result += `(?:${options.map(option => globToRegexSource(option)).join('|')})`;
        index = end;
        continue;
      }
    }

    if (character === '[') {
      const end = glob.indexOf(']', index);

      if (end > index) {
        const characterClass = glob.slice(index + 1, end).replace(/^!/, '^');
        result += `[${characterClass}]`;
        index = end;
        continue;
      }
    }

    result += escapeRegExp(character);
  }

  return result;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
