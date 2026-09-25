import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import {
  DEFAULT_IGNORED_GLOBS,
  extractPatchPath,
  filterIgnoredPatches,
  formatBytes,
  looksBinary,
  matchesAnyGlob,
  MAX_UNTRACKED_FILE_BYTES,
  splitFilePatches
} from '../src/pathFilters';

const SAMPLE_DIFF = [
  'diff --git a/src/icon.svg b/src/icon.svg',
  'index 1111111..2222222 100644',
  '--- a/src/icon.svg',
  '+++ b/src/icon.svg',
  '@@ -1 +1 @@',
  '-<svg/>',
  '+<svg><path/></svg>',
  'diff --git a/src/app.ts b/src/app.ts',
  'index 3333333..4444444 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1 +1 @@',
  '-console.log(1)',
  '+console.log(2)'
].join('\n');

const COMBINED_MERGE_DIFF = [
  'diff --cc src/logo.svg',
  'index 1111111,2222222..3333333',
  '--- a/src/logo.svg',
  '+++ b/src/logo.svg',
  '@@@ -1,1 -1,1 +1,1 @@@',
  '--<svg/>',
  '++<svg><path/></svg>',
  'diff --cc src/app.ts',
  'index 4444444,5555555..6666666',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@@ -1,1 -1,1 +1,1 @@@',
  '--console.log(1)',
  '++console.log(2)'
].join('\n');

describe('path filters', () => {
  test('matches brace, wildcard, and case-insensitive globs', () => {
    expect(matchesAnyGlob('src/icon.svg', ['**/*.{png,jpg,svg}'])).toBe(true);
    expect(matchesAnyGlob('src/icon.PNG', ['**/*.{png,jpg,svg}'])).toBe(true);
    expect(matchesAnyGlob('deep/nested/logo.webp', ['**/*.{png,webp}'])).toBe(true);
    expect(matchesAnyGlob('src/readme.md', ['**/*.{png,jpg,svg}'])).toBe(false);
  });

  test('treats patterns without a slash as matching at any depth', () => {
    expect(matchesAnyGlob('icon.svg', ['*.svg'])).toBe(true);
    expect(matchesAnyGlob('deep/icon.svg', ['*.svg'])).toBe(true);
    expect(matchesAnyGlob('deep/icon.svg', ['src/*.svg'])).toBe(false);
    expect(matchesAnyGlob('src/icon.svg', ['src/*.svg'])).toBe(true);
  });

  test('normalizes backslashes, leading slashes, and directory patterns', () => {
    expect(matchesAnyGlob('src\\icon.svg', ['**/*.svg'])).toBe(true);
    expect(matchesAnyGlob('src/app.ts', ['/src/app.ts'])).toBe(true);
    expect(matchesAnyGlob('dist/app.js', ['dist/'])).toBe(true);
    expect(matchesAnyGlob('src/dist/app.js', ['dist/'])).toBe(false);
    expect(matchesAnyGlob('a.ts', ['   ', ''])).toBe(false);
    expect(matchesAnyGlob('a.ts', [])).toBe(false);
  });

  test('supports character classes and question marks', () => {
    expect(matchesAnyGlob('assets/file1.txt', ['**/file[0-9].txt'])).toBe(true);
    expect(matchesAnyGlob('assets/fileX.txt', ['**/file[0-9].txt'])).toBe(false);
    expect(matchesAnyGlob('assets/a.txt', ['**/?.txt'])).toBe(true);
  });

  test('ignores malformed globs instead of throwing', () => {
    expect(matchesAnyGlob('src/app.ts', ['[z-a]'])).toBe(false);
    expect(() => filterIgnoredPatches(SAMPLE_DIFF, ['[z-a]'])).not.toThrow();
    expect(filterIgnoredPatches(SAMPLE_DIFF, ['[z-a]'])).toBe(SAMPLE_DIFF);
  });

  test('matches representative default ignore paths', () => {
    expect(matchesAnyGlob('assets/logo.svg', DEFAULT_IGNORED_GLOBS)).toBe(true);
    expect(matchesAnyGlob('bun.lock', DEFAULT_IGNORED_GLOBS)).toBe(true);
    expect(matchesAnyGlob('src/app.js.map', DEFAULT_IGNORED_GLOBS)).toBe(true);
    expect(matchesAnyGlob('public/font.woff2', DEFAULT_IGNORED_GLOBS)).toBe(true);
    expect(matchesAnyGlob('bundle.min.css', DEFAULT_IGNORED_GLOBS)).toBe(true);
    expect(matchesAnyGlob('models/scene.fbx', DEFAULT_IGNORED_GLOBS)).toBe(true);
    expect(matchesAnyGlob('src/index.ts', DEFAULT_IGNORED_GLOBS)).toBe(false);
    // Regression guard: `admin.js` must not match `**/*.min.js`.
    expect(matchesAnyGlob('src/admin.js', DEFAULT_IGNORED_GLOBS)).toBe(false);
  });

  test('keeps the manifest default in sync with DEFAULT_IGNORED_GLOBS', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const promptCategory = manifest.contributes.configuration.find(
      (category: { id: string }) => category.id === 'gitCommitPlanner.prompt'
    );
    const configured = promptCategory.properties['gitCommitPlanner.ignoredGlobs'].default;

    expect(configured).toEqual(DEFAULT_IGNORED_GLOBS);
    expect(MAX_UNTRACKED_FILE_BYTES).toBe(1048576);
  });

  test('extracts paths from modified, deleted, and renamed patches', () => {
    expect(extractPatchPath(SAMPLE_DIFF.split(/(?=^diff --git )/m)[0])).toBe('src/icon.svg');
    expect(extractPatchPath([
      'diff --git a/assets/logo.png b/assets/logo.png',
      'deleted file mode 100644',
      'index abc1234..0000000',
      '--- a/assets/logo.png',
      '+++ /dev/null',
      'Binary files a/assets/logo.png and /dev/null differ'
    ].join('\n'))).toBe('assets/logo.png');
    expect(extractPatchPath([
      'diff --git a/icons/old.svg b/icons/new.svg',
      'similarity index 100%',
      'rename from icons/old.svg',
      'rename to icons/new.svg'
    ].join('\n'))).toBe('icons/new.svg');
    expect(extractPatchPath([
      'diff --git "a/my file.svg" "b/my file.svg"',
      'similarity index 100%',
      'rename from my file.svg',
      'rename to my file.svg'
    ].join('\n'))).toBe('my file.svg');
  });

  test('handles CRLF headers and non-array globs defensively', () => {
    const crlf = [
      'diff --git "a/my file.svg" "b/my file.svg"',
      'similarity index 100%',
      'rename from my file.svg',
      'rename to my file.svg'
    ].join('\r\n') + '\r\n';

    expect(extractPatchPath(crlf)).toBe('my file.svg');
    expect(() => filterIgnoredPatches(SAMPLE_DIFF, null as unknown as string[])).not.toThrow();
    expect(filterIgnoredPatches(SAMPLE_DIFF, null as unknown as string[])).toBe(SAMPLE_DIFF);
  });

  test('omits content for ignored patches only and preserves spacing', () => {
    const filtered = filterIgnoredPatches(SAMPLE_DIFF, ['**/*.svg']);

    expect(filtered).toContain('diff --git a/src/icon.svg b/src/icon.svg');
    expect(filtered).toContain('gitCommitPlanner.ignoredGlobs');
    expect(filtered).not.toContain('<svg><path/></svg>');
    expect(filtered).toContain('+console.log(2)');
    // Untouched patches keep their original spacing (single newline separator).
    expect(filtered).toContain('gitCommitPlanner.ignoredGlobs.]\ndiff --git a/src/app.ts');
  });

  test('returns the diff unchanged when nothing matches or no globs are set', () => {
    expect(filterIgnoredPatches(SAMPLE_DIFF, ['**/*.png'])).toBe(SAMPLE_DIFF);
    expect(filterIgnoredPatches(SAMPLE_DIFF, [])).toBe(SAMPLE_DIFF);
    expect(filterIgnoredPatches('', ['**/*.svg'])).toBe('');
  });

  test('splits combined merge diffs and filters one file without losing others', () => {
    expect(splitFilePatches(COMBINED_MERGE_DIFF)).toHaveLength(2);

    const filtered = filterIgnoredPatches(COMBINED_MERGE_DIFF, ['**/*.svg']);

    expect(filtered).toContain('diff --cc src/logo.svg');
    expect(filtered).not.toContain('++<svg><path/></svg>');
    expect(filtered).toContain('diff --cc src/app.ts');
    expect(filtered).toContain('++console.log(2)');
  });

  test('splits patches at diff boundaries and preserves a single chunk', () => {
    expect(splitFilePatches(SAMPLE_DIFF)).toHaveLength(2);
    expect(splitFilePatches('not a patch')).toEqual(['not a patch']);
  });

  test('detects binary content by NUL byte and invalid UTF-8', () => {
    expect(looksBinary(new Uint8Array([0x50, 0x4e, 0x47, 0x00, 0x01]))).toBe(true);
    expect(looksBinary(new Uint8Array(300).fill(0xff))).toBe(true);
    expect(looksBinary(new Uint8Array(100).fill(0xff))).toBe(true);
    expect(looksBinary(new Uint8Array())).toBe(false);
    expect(looksBinary(new TextEncoder().encode('const value = 1;\n'.repeat(40)))).toBe(false);
  });

  test('formats byte counts for placeholders', () => {
    expect(formatBytes(MAX_UNTRACKED_FILE_BYTES)).toBe('1 MB');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(512)).toBe('512 bytes');
  });
});
